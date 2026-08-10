/**
 * File-backed accounts store with cross-process safety.
 *
 * Reads are atomic snapshots (the file is replaced via rename, never written
 * in place), so a concurrent reader always sees either the previous or the
 * new content. Mutations and explicit writes are serialized through a
 * `accounts.json.lock` file next to the data file: exclusive create with
 * bounded retries, mtime-based stale-lock cleanup, and a token so release
 * only removes our own lock. Mutations always re-read the latest on-disk
 * content while holding the lock, then merge — a coordinator can therefore
 * never clobber another process's update.
 *
 * Missing files fall back to an empty, valid {@link AccountsFile}. Malformed
 * files are never overwritten: reads and mutations surface an error that
 * names the file and the problem instead.
 *
 * The data file is written atomically (temp file + rename) with mode 0600;
 * the parent directory is created with mode 0700 when needed.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  ACCOUNTS_FILE_NAME,
  type AccountsFile,
  defaultAccountsFile,
  parseAccountsFile,
  validateAccountsFile,
} from "./types.ts";

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 20;
const DEFAULT_STALE_LOCK_MS = 30_000;

/** Options accepted by {@link createAccountsStore}. */
export interface AccountsStoreOptions {
  /**
   * Path to the accounts.json file. Defaults to `<getAgentDir()>/accounts.json`.
   * Inject for tests or custom layouts.
   */
  filePath?: string;
  /** Total time to wait for the lock before failing. Default 2000 ms. */
  lockTimeoutMs?: number;
  /** Delay between lock retries. Default 20 ms. */
  retryDelayMs?: number;
  /**
   * A lock file older than this is considered stale and reclaimed.
   * Default 30 000 ms. Mutations should finish well within this.
   */
  staleLockMs?: number;
}

/** The store surface a coordinator interacts with. */
export interface AccountsStore {
  /**
   * Read the latest accounts file. Returns an empty, valid file when none
   * exists yet (without creating it). Throws a descriptive error when the
   * file exists but is malformed.
   */
  read(): Promise<AccountsFile>;
  /**
   * Atomically apply `update` against the latest on-disk content while
   * holding the cross-process lock. `update` receives a fresh snapshot and
   * returns the merged file; the result is validated and written atomically.
   * Resolves with the canonical written file.
   */
  mutate(update: (current: AccountsFile) => AccountsFile | Promise<AccountsFile>): Promise<AccountsFile>;
  /**
   * Explicitly persist `next`, serialized through the same lock and atomic
   * write. Refuses to overwrite an existing malformed file or to write an
   * invalid value.
   */
  write(next: AccountsFile): Promise<void>;
}

/** Default on-disk location: `<getAgentDir()>/accounts.json`. */
export function defaultAccountsFilePath(): string {
  return join(getAgentDir(), ACCOUNTS_FILE_NAME);
}

type LockOptions = { lockTimeoutMs: number; retryDelayMs: number; staleLockMs: number };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire an exclusive lock file. Returns a release function.
 *
 * Uses `open(path, "wx")` for atomic exclusive creation, bounded retries with
 * a small delay, and mtime-based stale-lock cleanup. The lock body carries a
 * random token so release never deletes a lock it does not own.
 */
async function acquireLock(lockPath: string, opts: LockOptions): Promise<() => Promise<void>> {
  const attempts = Math.max(1, Math.ceil(opts.lockTimeoutMs / opts.retryDelayMs));
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + opts.lockTimeoutMs;
  const lockBody = `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(lockBody, "utf8");
        await handle.close();
      } catch (err) {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
        throw err;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const holder = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
          if (holder.token === token) await rm(lockPath, { force: true });
        } catch {
          // Lock already gone or unreadable — nothing left to release.
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      // Someone holds the lock. Reclaim it when stale, otherwise retry.
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > opts.staleLockMs) {
          // Rename claims the stale lock atomically: only one contender wins,
          // losers see ENOENT and simply retry.
          const garbage = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
          await rename(lockPath, garbage);
          await rm(garbage, { force: true }).catch(() => {});
          continue;
        }
      } catch {
        // Lost the race or the lock vanished — fall through to a bounded retry.
      }
      if (Date.now() >= deadline || attempt + 1 >= attempts) break;
      await sleep(opts.retryDelayMs);
    }
  }
  throw new Error(
    `Timed out after ${opts.lockTimeoutMs}ms acquiring lock ${lockPath}; another process holds it (or the lock file is fresh).`,
  );
}

function serializeAccountsFile(value: AccountsFile): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write `data` to `target` atomically: temp file in the same directory (mode
 * 0600), fsync best-effort, then rename over the target. The parent directory
 * is created with mode 0700 when needed.
 */
async function writeFileAtomic(target: string, data: string): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (dir !== ".") await chmod(dir, 0o700).catch(() => {});
  const tmp = join(dir, `.${basename(target)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync().catch(() => {}); // durability, best-effort
    await handle.close();
    handle = undefined;
    await rename(tmp, target); // atomic replace on POSIX and Windows
    await chmod(target, 0o600).catch(() => {}); // guarantee 0600 regardless of umask
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Create the store bound to `filePath`. */
export function createAccountsStore(options: AccountsStoreOptions = {}): AccountsStore {
  const filePath = options.filePath ?? defaultAccountsFilePath();
  const lockPath = `${filePath}.lock`;
  const lockOpts: LockOptions = {
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
  };

  /** Read + validate; missing file falls back to empty defaults. */
  async function readAccounts(): Promise<AccountsFile> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultAccountsFile();
      throw err;
    }
    const parsed = parseAccountsFile(raw);
    if (!parsed.ok) throw new Error(`Malformed accounts file ${filePath}: ${parsed.error.message}`);
    return parsed.value;
  }

  /**
   * Validate `next`, refuse to clobber a malformed existing file, write
   * atomically, and resolve with the canonical written file.
   */
  async function writeAccounts(next: AccountsFile): Promise<AccountsFile> {
    const validated = validateAccountsFile(next);
    if (!validated.ok) {
      throw new Error(`Refusing to write invalid accounts file: ${validated.error.message}`);
    }
    const existing = await readFile(filePath, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
    if (existing !== undefined) {
      const parsed = parseAccountsFile(existing);
      if (!parsed.ok) {
        throw new Error(
          `Refusing to overwrite malformed accounts file ${filePath}: ${parsed.error.message}. Fix or delete it first.`,
        );
      }
    }
    await writeFileAtomic(filePath, serializeAccountsFile(validated.value));
    return validated.value;
  }

  return {
    read: readAccounts,
    async mutate(update) {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const release = await acquireLock(lockPath, lockOpts);
      try {
        const current = await readAccounts(); // latest on-disk content under the lock
        const next = await update(current);
        return await writeAccounts(next);
      } finally {
        await release();
      }
    },
    async write(next) {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const release = await acquireLock(lockPath, lockOpts);
      try {
        await writeAccounts(next);
      } finally {
        await release();
      }
    },
  };
}
