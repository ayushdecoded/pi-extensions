import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { AccountProfile, AccountsFile, LimitWindow } from "../src/accounts/types.ts";
import { defaultAccountsFile, parseAccountsFile, validateAccountsFile } from "../src/accounts/types.ts";
import { createAccountsStore } from "../src/accounts/store.ts";

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), "pi-accounts-"));

function profile(overrides: Partial<AccountProfile> = {}): AccountProfile {
  return {
    name: "Primary",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    limits: [],
    ...overrides,
  };
}

function limitWindow(overrides: Partial<LimitWindow> = {}): LimitWindow {
  return {
    name: "rate-limit",
    usedPercent: 30,
    windowSeconds: 3600,
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("read returns safe empty defaults for a missing file and does not create it", async () => {
  const filePath = join(await tmp(), "accounts.json");
  const store = createAccountsStore({ filePath });

  assert.deepEqual(await store.read(), defaultAccountsFile());
  await assert.rejects(stat(filePath), { code: "ENOENT" });
});

test("write → read round-trip preserves selections, multiple windows, and absent resets", async () => {
  const filePath = join(await tmp(), "accounts.json");
  const store = createAccountsStore({ filePath });
  const seeded: AccountsFile = {
    version: 1,
    selected: { "openai-codex": "default", "opencode-go": "op-2" },
    accounts: {
      "openai-codex": {
        default: profile({
          name: "Canonical Codex",
          limits: [
            limitWindow({ name: "primary", usedPercent: 55, windowSeconds: 3600 }),
            // Absent resetAt and windowSeconds are fine; absence must survive.
            limitWindow({ name: "secondary", usedPercent: 100, resetAt: "2025-01-01T02:00:00.000Z" }),
          ],
        }),
      },
      "opencode-go": {
        // No exhaustedAt, no resetAt, no limits: optional fields stay absent.
        "op-2": profile({ name: "OpenCode Workspace", exhaustedAt: "2025-01-01T00:30:00.000Z" }),
      },
    },
  };

  await store.write(seeded);
  assert.deepEqual(await store.read(), seeded);

  const onDisk = JSON.parse(await readFile(filePath, "utf8")) as AccountsFile;
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.accounts["openai-codex"].default.limits.length, 2);
  assert.deepEqual(onDisk.accounts["openai-codex"].default.limits[1].resetAt, "2025-01-01T02:00:00.000Z");
  assert.deepEqual(onDisk.accounts["openai-codex"].default.limits[0].resetAt, undefined);
  assert.deepEqual(onDisk.accounts["opencode-go"]["op-2"].exhaustedAt, "2025-01-01T00:30:00.000Z");
  assert.deepEqual(onDisk.accounts["opencode-go"]["op-2"].resetAt, undefined);
});

test("the canonical account lives under the 'default' key, not an isDefault field", async () => {
  const filePath = join(await tmp(), "accounts.json");
  const store = createAccountsStore({ filePath });
  const seeded: AccountsFile = {
    version: 1,
    selected: { "openai-codex": "default" },
    accounts: {
      "openai-codex": {
        default: profile({ name: "Canonical" }),
        secondary: profile({ name: "Secondary" }),
      },
    },
  };

  await store.write(seeded);
  const got = await store.read();
  assert.equal(got.accounts["openai-codex"].default.name, "Canonical");
  assert.equal(got.accounts["openai-codex"]["secondary"].name, "Secondary");
  assert.equal(got.selected["openai-codex"], "default");

  // isDefault is not part of the schema: it is dropped on validation and write.
  const withIsDefault = {
    version: 1,
    selected: {},
    accounts: { "openai-codex": { default: { ...profile(), isDefault: true } } },
  };
  const validated = validateAccountsFile(withIsDefault);
  assert.ok(validated.ok);
  assert.ok(!("isDefault" in validated.value.accounts["openai-codex"].default));
  await store.write(withIsDefault as unknown as AccountsFile);
  assert.ok(!("isDefault" in (await store.read()).accounts["openai-codex"].default));
});

test("creates the parent directory 0700 and writes the file 0600", { skip: process.platform === "win32" }, async () => {
  const filePath = join(await tmp(), "nested", "accounts.json");
  const store = createAccountsStore({ filePath });

  await store.write(defaultAccountsFile());

  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(filePath))).mode & 0o777, 0o700);
});

test("malformed files surface a useful error and are never overwritten", async () => {
  const filePath = join(await tmp(), "accounts.json");
  const store = createAccountsStore({ filePath });
  const garbage = "{ definitely not json";
  await writeFile(filePath, garbage, { mode: 0o600 });

  await assert.rejects(store.read(), /Malformed accounts file .*invalid JSON/);
  await assert.rejects(store.mutate((f) => f), /Malformed accounts file .*invalid JSON/);
  await assert.rejects(store.write(defaultAccountsFile()), /Refusing to overwrite malformed accounts file/);
  assert.equal(await readFile(filePath, "utf8"), garbage);

  // Valid JSON with the wrong shape is surfaced too, not clobbered.
  const wrongShape = JSON.stringify({ version: 99 });
  await writeFile(filePath, wrongShape, { mode: 0o600 });
  await assert.rejects(store.read(), /unsupported version/);
  await assert.rejects(store.mutate((f) => f), /unsupported version/);
  assert.equal(await readFile(filePath, "utf8"), wrongShape);
});

test("concurrent mutations from separate stores merge against latest disk content", async () => {
  const filePath = join(await tmp(), "accounts.json");
  const opts = { filePath, lockTimeoutMs: 10_000, staleLockMs: 60_000 };
  const a = createAccountsStore(opts);
  const b = createAccountsStore(opts);
  const count = 12;

  await Promise.all([
    ...Array.from({ length: count }, (_, i) =>
      a.mutate((f) => ({
        ...f,
        accounts: {
          ...f.accounts,
          "openai-codex": { ...f.accounts["openai-codex"], [`acct-a-${i}`]: profile({ name: `A-${i}` }) },
        },
      })),
    ),
    ...Array.from({ length: count }, (_, i) =>
      b.mutate((f) => ({
        ...f,
        accounts: {
          ...f.accounts,
          "opencode-go": { ...f.accounts["opencode-go"], [`acct-b-${i}`]: profile({ name: `B-${i}` }) },
        },
      })),
    ),
  ]);

  const final = await a.read();
  assert.equal(Object.keys(final.accounts["openai-codex"]).length, count);
  assert.equal(Object.keys(final.accounts["opencode-go"]).length, count);
  assert.equal(Object.keys(final.accounts).length, 2);
});

test("a stale lock file is reclaimed and cleaned up", async () => {
  const filePath = join(await tmp(), "accounts.json");
  const lockPath = `${filePath}.lock`;
  await writeFile(lockPath, JSON.stringify({ token: "dead-process", pid: 1 }), { mode: 0o600 });
  const past = new Date(Date.now() - 60_000);
  await utimes(lockPath, past, past);

  const store = createAccountsStore({ filePath, staleLockMs: 5_000 });
  const result = await store.mutate((f) => ({ ...f, selected: { ...f.selected, "openai-codex": "acct-1" } }));

  assert.equal(result.selected["openai-codex"], "acct-1");
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
});

test("a fresh lock fails after bounded retries instead of hanging", async () => {
  const filePath = join(await tmp(), "accounts.json");
  const lockPath = `${filePath}.lock`;
  await writeFile(lockPath, JSON.stringify({ token: "someone-else", pid: 999999 }), { mode: 0o600 });

  const store = createAccountsStore({ filePath, lockTimeoutMs: 200, retryDelayMs: 25, staleLockMs: 60_000 });
  const started = Date.now();

  await assert.rejects(store.mutate((f) => f), /Timed out after 200ms acquiring lock/);
  assert.ok(Date.now() - started < 10_000, "mutate should fail quickly instead of hanging");
  assert.match(await readFile(lockPath, "utf8"), /someone-else/, "fresh lock must not be removed");
});

test("mutate refuses to write an invalid result and leaves no file behind", async () => {
  const filePath = join(await tmp(), "accounts.json");
  const store = createAccountsStore({ filePath });

  await assert.rejects(
    store.mutate(() => ({ version: 2, selected: {}, accounts: {} }) as unknown as AccountsFile),
    /Refusing to write invalid accounts file/,
  );
  await assert.rejects(stat(filePath), { code: "ENOENT" });
});

test("validation enforces percentages, durations, timestamps, and required fields", () => {
  const file = (accounts: unknown) => ({ version: 1, selected: {}, accounts });

  assert.equal(parseAccountsFile("").ok, false);
  assert.equal(parseAccountsFile("[]").ok, false);
  assert.equal(validateAccountsFile(null).ok, false);
  assert.equal(validateAccountsFile({ version: 2 }).ok, false);
  assert.equal(validateAccountsFile({ version: 1, selected: {}, accounts: {} }).ok, true);
  assert.equal(validateAccountsFile({ version: 1, selected: { "openai-codex": 7 }, accounts: {} }).ok, false);

  // usedPercent must be a finite number in 0..100 (inclusive).
  for (const usedPercent of [-1, 101, Number.NaN, Infinity]) {
    assert.equal(
      validateAccountsFile(file({ p: { a: profile({ limits: [limitWindow({ usedPercent })] }) } })).ok,
      false,
      `usedPercent ${usedPercent} must be rejected`,
    );
  }
  assert.ok(
    validateAccountsFile(file({ p: { a: profile({ limits: [limitWindow({ usedPercent: 0 }), limitWindow({ usedPercent: 100 })] }) } })).ok,
  );

  // windowSeconds must be positive.
  for (const windowSeconds of [0, -5]) {
    assert.equal(
      validateAccountsFile(file({ p: { a: profile({ limits: [limitWindow({ windowSeconds })] }) } })).ok,
      false,
      `windowSeconds ${windowSeconds} must be rejected`,
    );
  }
  assert.ok(validateAccountsFile(file({ p: { a: profile({ limits: [limitWindow({ windowSeconds: 60 })] }) } })).ok);

  // Timestamps must be parseable; optional resets may be absent.
  const badTimestampCases: Array<[string, Partial<AccountProfile>]> = [
    ["createdAt", { createdAt: "not-a-date" }],
    ["updatedAt", { updatedAt: "not-a-date" }],
    ["exhaustedAt", { exhaustedAt: "not-a-date" }],
    ["resetAt", { resetAt: "not-a-date" }],
  ];
  for (const [field, overrides] of badTimestampCases) {
    assert.equal(validateAccountsFile(file({ p: { a: profile(overrides) } })).ok, false, `${field} must be validated`);
  }
  assert.equal(
    validateAccountsFile(file({ p: { a: profile({ limits: [limitWindow({ resetAt: "not-a-date" })] }) } })).ok,
    false,
  );
  assert.equal(
    validateAccountsFile(file({ p: { a: profile({ limits: [limitWindow({ updatedAt: "not-a-date" })] }) } })).ok,
    false,
  );
  // Absent optional resets are valid everywhere.
  assert.ok(validateAccountsFile(file({ p: { a: profile({ limits: [limitWindow({ resetAt: undefined })] }) } })).ok);

  // name is required; limits must be an array (zero or more allowed).
  assert.equal(validateAccountsFile(file({ p: { a: { ...profile(), name: "" } } })).ok, false);
  assert.equal(validateAccountsFile(file({ p: { a: { ...profile(), limits: "none" } } })).ok, false);
  assert.ok(validateAccountsFile(file({ p: { a: profile({ limits: [] }) } })).ok);

  // A valid profile with two windows validates and keeps its shape.
  const valid = validateAccountsFile(
    file({ p: { a: profile({ limits: [limitWindow({ name: "primary" }), limitWindow({ name: "secondary" })] }) } }),
  );
  assert.ok(valid.ok);
  assert.deepEqual(valid.value.accounts.p.a.limits.map((w) => w.name), ["primary", "secondary"]);
});
