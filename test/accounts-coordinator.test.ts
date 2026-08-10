/**
 * Behavioral tests for {@link AccountCoordinator} against an in-memory
 * {@link AccountsStore} double that mirrors the file store contract: reads
 * return a fresh snapshot, `mutate` applies `update` to the latest snapshot
 * under an implicit lock and persists the result.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { AccountCoordinator, isProfileExhausted } from "../src/accounts/coordinator.ts";
import type { AccountsStore } from "../src/accounts/store.ts";
import {
  DEFAULT_ACCOUNT_KEY,
  defaultAccountsFile,
  type AccountProfile,
  type AccountsFile,
  type LimitWindow,
} from "../src/accounts/types.ts";

const P = "openai-codex";
const OTHER = "opencode-go";
const NOW = 1_735_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

let now = NOW;
const clock = (): number => now;
beforeEach(() => {
  now = NOW;
});

/** In-memory AccountsStore double (no disk, no locking, atomic snapshots). */
class InMemoryStore implements AccountsStore {
  reads = 0;
  mutates = 0;
  writes = 0;
  private file: AccountsFile;
  constructor(seed?: AccountsFile) {
    this.file = seed ? structuredClone(seed) : defaultAccountsFile();
  }
  async read(): Promise<AccountsFile> {
    this.reads += 1;
    return structuredClone(this.file);
  }
  async mutate(update: (current: AccountsFile) => AccountsFile | Promise<AccountsFile>): Promise<AccountsFile> {
    this.mutates += 1;
    const next = await update(structuredClone(this.file));
    this.file = structuredClone(next);
    return structuredClone(this.file);
  }
  async write(next: AccountsFile): Promise<void> {
    this.writes += 1;
    this.file = structuredClone(next);
  }
  content(): AccountsFile {
    return structuredClone(this.file);
  }
}

function profile(overrides: Partial<AccountProfile> = {}): AccountProfile {
  return { name: "Primary", createdAt: iso(NOW), updatedAt: iso(NOW), limits: [], ...overrides };
}

function limitWindow(overrides: Partial<LimitWindow> = {}): LimitWindow {
  return { name: "rate-limit", usedPercent: 30, windowSeconds: 3600, updatedAt: iso(NOW), ...overrides };
}

function seeded(accounts: Record<string, AccountProfile>, selected = DEFAULT_ACCOUNT_KEY): AccountsFile {
  return { version: 1, selected: { [P]: selected }, accounts: { [P]: accounts } };
}

// ---------------------------------------------------------------------------
// Synthesized default accounts
// ---------------------------------------------------------------------------

test("accounts() synthesizes a selected default account for an untouched provider without persisting", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  assert.deepEqual(coordinator.accounts(P), [
    {
      id: DEFAULT_ACCOUNT_KEY,
      provider: P,
      name: "default",
      createdAt: iso(NOW),
      updatedAt: iso(NOW),
      limits: [],
      selected: true,
      exhausted: false,
    },
  ]);
  assert.deepEqual(store.content(), defaultAccountsFile()); // nothing written
});

test("profile() synthesizes the default profile when nothing is stored", async () => {
  const coordinator = new AccountCoordinator(new InMemoryStore(), clock);
  await coordinator.initialize();
  assert.deepEqual(coordinator.profile(P, DEFAULT_ACCOUNT_KEY), {
    name: "default",
    createdAt: iso(NOW),
    updatedAt: iso(NOW),
    limits: [],
  });
});

test("selectedAccountId falls back to the default key when nothing is selected or the selection is stale", async () => {
  const coordinator = new AccountCoordinator(new InMemoryStore(), clock);
  await coordinator.initialize();
  assert.equal(coordinator.selectedAccountId(P), DEFAULT_ACCOUNT_KEY);

  const store = new InMemoryStore({ version: 1, selected: { [P]: "ghost" }, accounts: {} });
  const stale = new AccountCoordinator(store, clock);
  await stale.initialize();
  assert.equal(stale.selectedAccountId(P), DEFAULT_ACCOUNT_KEY);
});

test("addAccount persists a synthesized default profile alongside the new account", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  const id = await coordinator.addAccount(P, "  Alpha  ");
  const state = store.content();
  assert.ok(state.accounts[P][DEFAULT_ACCOUNT_KEY]);
  assert.equal(state.accounts[P][DEFAULT_ACCOUNT_KEY].name, "default");
  assert.equal(state.accounts[P][id].name, "Alpha"); // trimmed
  assert.equal(state.accounts[P][id].createdAt, iso(NOW));
  assert.equal(state.accounts[P][id].updatedAt, iso(NOW));
  assert.deepEqual(state.accounts[P][id].limits, []);

  const views = coordinator.accounts(P);
  assert.equal(views.length, 2);
  assert.equal(views.find((a) => a.id === DEFAULT_ACCOUNT_KEY)?.selected, true);
  assert.equal(views.find((a) => a.id === id)?.selected, false);
});

// ---------------------------------------------------------------------------
// add / duplicate / rename / remove / select
// ---------------------------------------------------------------------------

test("addAccount validates names and rejects case-insensitive duplicates without touching state", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  await assert.rejects(coordinator.addAccount(P, ""), /cannot be empty/);
  await assert.rejects(coordinator.addAccount(P, "   "), /cannot be empty/);
  await assert.rejects(coordinator.addAccount(P, "x".repeat(61)), /at most 60/);

  const id = await coordinator.addAccount(P, "Alpha");
  await assert.rejects(coordinator.addAccount(P, "alpha"), /already has an account named alpha/i);
  await assert.rejects(coordinator.addAccount(P, "  ALPHA  "), /already has an account named alpha/i);

  const state = store.content();
  assert.equal(Object.keys(state.accounts[P]).length, 2); // default + Alpha only
  assert.ok(state.accounts[P][id]);
});

test("renameAccount updates name and timestamp and rejects unknown and duplicate targets", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();
  const a = await coordinator.addAccount(P, "Alpha");
  const b = await coordinator.addAccount(P, "Beta");

  now += 60_000;
  await coordinator.renameAccount(P, a, "  Alpha Prime  ");
  const state = store.content();
  assert.equal(state.accounts[P][a].name, "Alpha Prime"); // trimmed
  assert.equal(state.accounts[P][a].updatedAt, iso(now));
  assert.equal(state.accounts[P][b].name, "Beta"); // untouched sibling

  // Case-only rename of the same account is allowed (self excluded from dup check).
  await coordinator.renameAccount(P, a, "ALPHA PRIME");
  assert.equal(store.content().accounts[P][a].name, "ALPHA PRIME");

  await assert.rejects(coordinator.renameAccount(P, b, "alpha prime"), /already has an account named/i);
  await assert.rejects(coordinator.renameAccount(P, "ghost", "Gamma"), /Unknown openai-codex account: ghost/);
  await assert.rejects(coordinator.renameAccount(P, b, "   "), /cannot be empty/);
});

test("removeAccount forbids the default, rejects unknowns, and resets selection to default", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();
  const a = await coordinator.addAccount(P, "Alpha");
  const b = await coordinator.addAccount(P, "Beta");

  await assert.rejects(coordinator.removeAccount(P, DEFAULT_ACCOUNT_KEY), /cannot be removed/);
  await assert.rejects(coordinator.removeAccount(P, "ghost"), /Unknown openai-codex account: ghost/);

  // Removing a non-selected account leaves the selection alone.
  await coordinator.removeAccount(P, a);
  assert.equal(store.content().selected[P], DEFAULT_ACCOUNT_KEY);
  assert.equal(coordinator.accounts(P).length, 2); // default + Beta

  // Removing the selected account resets selection to the default.
  const c = await coordinator.addAccount(P, "Gamma");
  await coordinator.selectAccount(P, c);
  assert.equal(store.content().selected[P], c);
  await coordinator.removeAccount(P, c);
  assert.equal(store.content().selected[P], DEFAULT_ACCOUNT_KEY);
  assert.equal(coordinator.selectedAccountId(P), DEFAULT_ACCOUNT_KEY);
});

test("selectAccount marks the account selected, accepts the default key, and rejects unknowns", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();
  const a = await coordinator.addAccount(P, "Alpha");
  const b = await coordinator.addAccount(P, "Beta");

  await coordinator.selectAccount(P, b);
  assert.equal(store.content().selected[P], b);
  assert.deepEqual(
    coordinator.accounts(P).map((acc) => [acc.id, acc.selected]),
    [
      [DEFAULT_ACCOUNT_KEY, false],
      [a, false],
      [b, true],
    ],
  );

  await assert.rejects(coordinator.selectAccount(P, "ghost"), /Unknown openai-codex account: ghost/);
  assert.equal(store.content().selected[P], b); // unchanged after failed select

  await coordinator.selectAccount(P, DEFAULT_ACCOUNT_KEY);
  assert.equal(store.content().selected[P], DEFAULT_ACCOUNT_KEY);
});

test("provider accounts and selections are isolated per provider", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  const id = await coordinator.addAccount(P, "Codex Alpha");
  const otherId = await coordinator.addAccount(OTHER, "Open Beta");
  await coordinator.selectAccount(P, id);

  const state = store.content();
  assert.equal(state.selected[P], id);
  assert.equal(state.selected[OTHER], DEFAULT_ACCOUNT_KEY);
  assert.equal(state.accounts[P][otherId], undefined);
  assert.equal(coordinator.accounts(P).length, 2);
  assert.equal(coordinator.accounts(OTHER).length, 2);
});

// ---------------------------------------------------------------------------
// Global mutation serialization
// ---------------------------------------------------------------------------

test("concurrent mutations are serialized and all persisted", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  const names = Array.from({ length: 25 }, (_, i) => `Worker ${i}`);
  const ids = await Promise.all(names.map((name) => coordinator.addAccount(P, name)));

  assert.equal(new Set(ids).size, names.length); // unique uuids
  const state = store.content();
  assert.equal(Object.keys(state.accounts[P]).length, names.length + 1); // + synthesized default
  for (const name of names) {
    assert.ok(Object.values(state.accounts[P]).some((p) => p.name === name), `missing ${name}`);
  }
  assert.equal(store.mutates, names.length);
});

test("concurrent mixed mutations apply in a consistent serial order", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();
  const a = await coordinator.addAccount(P, "A");
  const b = await coordinator.addAccount(P, "B");

  await Promise.all([
    coordinator.selectAccount(P, a),
    coordinator.selectAccount(P, b),
    coordinator.renameAccount(P, a, "A renamed"),
  ]);

  const state = store.content();
  assert.equal(state.accounts[P][a].name, "A renamed");
  assert.ok([a, b].includes(state.selected[P]));
  assert.equal(store.mutates, 5); // 2 adds + 3 concurrent mutations, all serialized
});

test("a rejected mutation does not poison the serialized mutation chain", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();
  await coordinator.addAccount(P, "Alpha");

  await assert.rejects(coordinator.addAccount(P, "alpha")); // duplicate
  const id = await coordinator.addAccount(P, "Beta"); // chain still works
  assert.equal(coordinator.accounts(P).length, 3);
  assert.ok(store.content().accounts[P][id]);
});

test("mutations initialize the coordinator lazily", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  const id = await coordinator.addAccount(P, "Alpha"); // no explicit initialize()
  assert.ok(id);
  assert.equal(store.content().accounts[P][id].name, "Alpha");
  assert.equal(store.reads, 1);
});

// ---------------------------------------------------------------------------
// Multiple limits / missing resets
// ---------------------------------------------------------------------------

test("updateLimits stores multiple windows and missing resets, bumping updatedAt", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();
  const a = await coordinator.addAccount(P, "Alpha");

  now += 60_000;
  await coordinator.updateLimits(P, a, [
    limitWindow({ name: "primary", usedPercent: 55 }),
    limitWindow({ name: "secondary", usedPercent: 100, resetAt: iso(now + 3_600_000) }),
  ]);
  let state = store.content();
  assert.equal(state.accounts[P][a].limits.length, 2);
  assert.deepEqual(state.accounts[P][a].limits[0], {
    name: "primary",
    usedPercent: 55,
    windowSeconds: 3600,
    updatedAt: iso(NOW), // window timestamps are preserved as given
  });
  assert.equal(state.accounts[P][a].limits[1].resetAt, iso(now + 3_600_000));
  assert.equal(state.accounts[P][a].updatedAt, iso(now)); // profile bumped

  // A window without resetAt stays absent; a window without usedPercent stays undefined.
  await coordinator.updateLimits(P, a, [
    limitWindow({ name: "primary", usedPercent: 99 }),
    limitWindow({ name: "secondary", usedPercent: undefined }),
  ]);
  state = store.content();
  assert.equal(state.accounts[P][a].limits[1].usedPercent, undefined);
  assert.equal("resetAt" in state.accounts[P][a].limits[1], false);
});

test("updateLimits clears exhaustion only when every window is below 100", async () => {
  // All windows healthy (<100) → clears exhaustion markers.
  let store = new InMemoryStore(
    seeded({ default: profile({ name: "Canonical" }), a: profile({ name: "Alpha", exhaustedAt: iso(NOW) }) }, "a"),
  );
  let coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();
  await coordinator.updateLimits(P, "a", [limitWindow({ name: "primary", usedPercent: 40 })]);
  let state = store.content();
  assert.equal("exhaustedAt" in state.accounts[P].a, false);
  assert.equal("resetAt" in state.accounts[P].a, false);

  // A blocking window keeps exhaustion and refreshes the displayed reset time.
  store = new InMemoryStore(
    seeded({ default: profile({ name: "Canonical" }), a: profile({ name: "Alpha", exhaustedAt: iso(NOW) }) }, "a"),
  );
  coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();
  await coordinator.updateLimits(P, "a", [
    limitWindow({ name: "primary", usedPercent: 100, resetAt: iso(now + 3_600_000) }),
  ]);
  state = store.content();
  assert.equal(state.accounts[P].a.exhaustedAt, iso(NOW));
  assert.equal(state.accounts[P].a.resetAt, iso(now + 3_600_000));

  // A moved provider reset replaces the stored profile reset.
  await coordinator.updateLimits(P, "a", [
    limitWindow({ name: "primary", usedPercent: 100, resetAt: iso(now + 7_200_000) }),
  ]);
  assert.equal(store.content().accounts[P].a.resetAt, iso(now + 7_200_000));

  // Empty limits keep the exhaustion (documented: only non-empty all-healthy
  // windows prove recovery; only clearExhaustion resets it).
  store = new InMemoryStore(
    seeded({ default: profile({ name: "Canonical" }), a: profile({ name: "Alpha", exhaustedAt: iso(NOW) }) }, "a"),
  );
  coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();
  await coordinator.updateLimits(P, "a", []);
  state = store.content();
  assert.equal(state.accounts[P].a.exhaustedAt, iso(NOW));
  assert.equal(state.accounts[P].a.limits.length, 0);
});

test("clearExhaustion removes exhaustion markers and bumps updatedAt", async () => {
  const store = new InMemoryStore(
    seeded(
      { default: profile({ name: "Canonical" }), a: profile({ name: "Alpha", exhaustedAt: iso(NOW) }) },
      "a",
    ),
  );
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  now += 120_000;
  await coordinator.clearExhaustion(P, "a");
  const state = store.content();
  assert.equal("exhaustedAt" in state.accounts[P].a, false);
  assert.equal("resetAt" in state.accounts[P].a, false);
  assert.equal(state.accounts[P].a.updatedAt, iso(now));
  assert.equal(coordinator.accounts(P).find((acc) => acc.id === "a")?.exhausted, false);
});

// ---------------------------------------------------------------------------
// Expiry semantics
// ---------------------------------------------------------------------------

test("isProfileExhausted applies reset-expiry semantics", () => {
  const base = profile();
  assert.equal(isProfileExhausted(base, now), false); // no exhaustedAt
  assert.equal(isProfileExhausted({ ...base, exhaustedAt: iso(NOW) }, now), true); // no resetAt → exhausted forever
  assert.equal(isProfileExhausted({ ...base, exhaustedAt: iso(NOW), resetAt: iso(NOW + 3_600_000) }, now), true);
  assert.equal(isProfileExhausted({ ...base, exhaustedAt: iso(NOW), resetAt: iso(NOW - 1) }, now), false);
  assert.equal(isProfileExhausted({ ...base, exhaustedAt: iso(NOW), resetAt: iso(NOW) }, now), false); // exactly now → recovered
});

test("accounts() reflects exhaustion and recovery through the injected clock", async () => {
  const store = new InMemoryStore(
    seeded(
      {
        default: profile({ name: "Canonical" }),
        a: profile({ name: "Alpha", exhaustedAt: iso(NOW), resetAt: iso(NOW + 3_600_000) }),
      },
      "a",
    ),
  );
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  assert.equal(coordinator.accounts(P).find((acc) => acc.id === "a")?.exhausted, true);
  now += 3_600_000; // reset elapses
  assert.equal(coordinator.accounts(P).find((acc) => acc.id === "a")?.exhausted, false);
});

// ---------------------------------------------------------------------------
// Failover: selection order, filtering, marking, no fallback
// ---------------------------------------------------------------------------

test("failover marks the exhausted account and selects the first healthy configured candidate in key order", async () => {
  const store = new InMemoryStore(
    seeded(
      {
        default: profile({ name: "Canonical" }),
        a: profile({ name: "A" }),
        b: profile({ name: "B" }),
        c: profile({ name: "C" }),
      },
      "a",
    ),
  );
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  now += 5_000;
  // default is deliberately not configured so key-order among named accounts
  // is observable: b comes before c.
  const result = await coordinator.failover(P, "a", new Set(["a", "b", "c"]), now + 3_600_000);
  assert.deepEqual(result, { provider: P, exhaustedAccountId: "a", selectedAccountId: "b", changed: true });

  const state = store.content();
  assert.equal(state.selected[P], "b");
  assert.equal(state.accounts[P].a.exhaustedAt, iso(now));
  assert.equal(state.accounts[P].a.updatedAt, iso(now));
  assert.equal(state.accounts[P].a.resetAt, iso(now + 3_600_000));
  assert.equal(coordinator.accounts(P).find((acc) => acc.id === "a")?.exhausted, true);
});

test("failover may fall back to the canonical default when it is configured and healthy", async () => {
  const store = new InMemoryStore(
    seeded(
      {
        default: profile({ name: "Canonical" }),
        a: profile({ name: "A" }),
        b: profile({ name: "B" }),
        c: profile({ name: "C" }),
      },
      "a",
    ),
  );
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  // The default account sorts first in key order and is a valid fallback when
  // the caller includes it in the configured set.
  const result = await coordinator.failover(P, "a", new Set([DEFAULT_ACCOUNT_KEY, "a", "b", "c"]));
  assert.deepEqual(result, { provider: P, exhaustedAccountId: "a", selectedAccountId: DEFAULT_ACCOUNT_KEY, changed: true });
  assert.equal(store.content().selected[P], DEFAULT_ACCOUNT_KEY);
});

test("failover ignores accounts outside the configured set", async () => {
  const store = new InMemoryStore(
    seeded(
      {
        default: profile({ name: "Canonical" }),
        a: profile({ name: "A" }),
        b: profile({ name: "B" }),
        c: profile({ name: "C" }),
      },
      "a",
    ),
  );
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  // b is not configured → skipped; c wins even though b sorts first.
  const result = await coordinator.failover(P, "a", new Set(["a", "c"]));
  assert.deepEqual(result, { provider: P, exhaustedAccountId: "a", selectedAccountId: "c", changed: true });
  assert.equal(store.content().selected[P], "c");
  assert.equal("resetAt" in store.content().accounts[P].a, false); // resetAtMs omitted → dropped
});

test("failover skips exhausted candidates and never falls back to the exhausted account", async () => {
  const store = new InMemoryStore(
    seeded(
      {
        default: profile({ name: "Canonical", exhaustedAt: iso(NOW) }), // no resetAt → exhausted forever
        a: profile({ name: "A" }),
        b: profile({ name: "B", exhaustedAt: iso(NOW), resetAt: iso(NOW + 3_600_000) }),
      },
      "a",
    ),
  );
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  const result = await coordinator.failover(P, "a", new Set([DEFAULT_ACCOUNT_KEY, "a", "b"]));
  assert.equal(result.provider, P);
  assert.equal(result.exhaustedAccountId, "a");
  assert.equal(result.selectedAccountId, undefined);
  assert.equal(result.changed, false);
  assert.equal(store.content().selected[P], "a"); // stays on the exhausted account
  assert.equal(store.content().accounts[P].a.exhaustedAt, iso(NOW)); // still marked
});

test("failover with no configured healthy candidate leaves selection untouched", async () => {
  const store = new InMemoryStore(
    seeded(
      {
        default: profile({ name: "Canonical" }),
        a: profile({ name: "A" }),
        b: profile({ name: "B" }), // healthy but NOT configured
      },
      "a",
    ),
  );
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  const result = await coordinator.failover(P, "a", new Set(["a"]));
  assert.equal(result.changed, false);
  assert.equal(result.selectedAccountId, undefined);
  assert.equal(store.content().selected[P], "a");
});

// ---------------------------------------------------------------------------
// Already-switched / concurrent exhaustion deduplication
// ---------------------------------------------------------------------------

test("failover returns the current selection unchanged when already switched away", async () => {
  const store = new InMemoryStore(
    seeded(
      {
        default: profile({ name: "Canonical" }),
        a: profile({ name: "A" }),
        b: profile({ name: "B" }),
      },
      "b", // already switched
    ),
  );
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  const result = await coordinator.failover(P, "a", new Set([DEFAULT_ACCOUNT_KEY, "a", "b"]), now + 3_600_000);
  assert.deepEqual(result, { provider: P, exhaustedAccountId: "a", selectedAccountId: "b", changed: false });

  const state = store.content();
  assert.equal(state.selected[P], "b"); // selection unchanged
  assert.equal(state.accounts[P].a.exhaustedAt, iso(NOW)); // but the account is still marked
  assert.equal(state.accounts[P].a.resetAt, iso(now + 3_600_000));
});

test("concurrent failovers for the same account deduplicate the switch", async () => {
  const store = new InMemoryStore(
    seeded(
      {
        default: profile({ name: "Canonical" }),
        a: profile({ name: "A" }),
        b: profile({ name: "B" }),
        c: profile({ name: "C" }),
      },
      "a",
    ),
  );
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  const configured = new Set(["a", "b", "c"]);
  const [first, second] = await Promise.all([
    coordinator.failover(P, "a", configured, now + 3_600_000),
    coordinator.failover(P, "a", configured, now + 3_600_000),
  ]);

  // Serialized mutation chain: the first call performs the switch, the second
  // observes the new selection and reports no change instead of switching again.
  assert.equal(first.changed, true);
  assert.equal(first.selectedAccountId, "b");
  assert.equal(second.changed, false);
  assert.equal(second.selectedAccountId, "b");

  const state = store.content();
  assert.equal(state.selected[P], "b");
  assert.equal(state.accounts[P].a.exhaustedAt, iso(NOW));
  assert.equal(coordinator.accounts(P).find((acc) => acc.id === "a")?.exhausted, true);
});

test("failover stores a resetAt only when a finite resetAtMs is provided", async () => {
  const store = new InMemoryStore(
    seeded({ default: profile({ name: "Canonical" }), a: profile({ name: "A" }) }, "a"),
  );
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  // Missing resetAtMs → resetAt dropped, exhausted forever.
  await coordinator.failover(P, "a", new Set([DEFAULT_ACCOUNT_KEY, "a"]));
  let state = store.content();
  assert.equal("resetAt" in state.accounts[P].a, false);
  assert.equal(state.accounts[P].a.exhaustedAt, iso(NOW));

  // NaN and Infinity resetAtMs are treated as missing.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await coordinator.clearExhaustion(P, "a");
    await coordinator.failover(P, "a", new Set([DEFAULT_ACCOUNT_KEY, "a"]), bad);
    assert.equal("resetAt" in store.content().accounts[P].a, false, `resetAt for ${bad}`);
  }

  // A past resetAtMs is stale guidance: omit it and keep the account exhausted.
  await coordinator.clearExhaustion(P, "a");
  await coordinator.failover(P, "a", new Set([DEFAULT_ACCOUNT_KEY, "a"]), now - 10_000);
  state = store.content();
  assert.equal("resetAt" in state.accounts[P].a, false);
  assert.equal(coordinator.accounts(P).find((acc) => acc.id === "a")?.exhausted, true);
});

// ---------------------------------------------------------------------------
// Store reload notifications
// ---------------------------------------------------------------------------

test("reload() returns false and does not notify when content is unchanged", async () => {
  const store = new InMemoryStore(seeded({ default: profile({ name: "Canonical" }) }));
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  let notifications = 0;
  const unsubscribe = coordinator.subscribe(() => {
    notifications += 1;
  });
  assert.equal(await coordinator.reload(), false);
  assert.equal(notifications, 0);
  unsubscribe();
});

test("reload() applies external store changes and notifies listeners exactly once", async () => {
  const store = new InMemoryStore(seeded({ default: profile({ name: "Canonical" }) }));
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();
  assert.deepEqual(coordinator.snapshot(), store.content());

  // External mutation that bypasses the coordinator.
  await store.mutate((latest) => {
    latest.accounts[P]!["ext"] = profile({ name: "External", limits: [] });
    latest.selected[P] = "ext";
    return latest;
  });

  let notifications = 0;
  const unsubscribe = coordinator.subscribe(() => {
    notifications += 1;
  });
  assert.equal(await coordinator.reload(), true);
  assert.equal(notifications, 1);
  assert.equal(coordinator.selectedAccountId(P), "ext");
  assert.equal(coordinator.accounts(P).find((acc) => acc.id === "ext")?.name, "External");

  // A second reload sees identical content → no change, no notification.
  assert.equal(await coordinator.reload(), false);
  assert.equal(notifications, 1);
  unsubscribe();
});

test("successful mutations notify subscribers and unsubscribing stops notifications", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  let notifications = 0;
  const unsubscribe = coordinator.subscribe(() => {
    notifications += 1;
  });

  const a = await coordinator.addAccount(P, "Alpha");
  assert.equal(notifications, 1);
  await coordinator.renameAccount(P, a, "Beta");
  assert.equal(notifications, 2);
  await assert.rejects(coordinator.addAccount(P, "beta")); // rejected → no notification
  assert.equal(notifications, 2);

  unsubscribe();
  await coordinator.removeAccount(P, a);
  assert.equal(notifications, 2); // no further notifications
});

test("initialize() reads the store exactly once and reload() re-reads", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await Promise.all([coordinator.initialize(), coordinator.initialize(), coordinator.initialize()]);
  assert.equal(store.reads, 1);
  await coordinator.reload();
  assert.equal(store.reads, 2);
});

// ---------------------------------------------------------------------------
// Snapshot / lookup helpers
// ---------------------------------------------------------------------------

test("snapshot() returns an independent deep copy", async () => {
  const store = new InMemoryStore(seeded({ default: profile({ name: "Canonical" }) }));
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  const snap = coordinator.snapshot();
  snap.accounts[P]![DEFAULT_ACCOUNT_KEY]!.name = "Mutated";
  assert.equal(store.content().accounts[P][DEFAULT_ACCOUNT_KEY].name, "Canonical");
  assert.equal(coordinator.snapshot().accounts[P][DEFAULT_ACCOUNT_KEY].name, "Canonical");
});

test("accountByName matches ids and names case-insensitively, including the synthesized default", async () => {
  const store = new InMemoryStore();
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();
  const a = await coordinator.addAccount(P, "Alpha");

  assert.equal(coordinator.accountByName(P, "ALPHA")?.id, a);
  assert.equal(coordinator.accountByName(P, a)?.name, "Alpha");
  assert.equal(coordinator.accountByName(P, "Default")?.id, DEFAULT_ACCOUNT_KEY);
  assert.equal(coordinator.accountByName(P, "missing"), undefined);
});

test("failover moves past an already-selected exhausted account", async () => {
  const store = new InMemoryStore(
    seeded(
      {
        default: profile({ name: "Canonical" }),
        a: profile({ name: "A" }),
        b: profile({ name: "B", exhaustedAt: iso(NOW), resetAt: iso(NOW + 3_600_000) }),
        c: profile({ name: "C" }),
      },
      "b",
    ),
  );
  const coordinator = new AccountCoordinator(store, clock);
  await coordinator.initialize();

  const result = await coordinator.failover(P, "a", new Set(["a", "b", "c"]));
  assert.deepEqual(result, { provider: P, exhaustedAccountId: "a", selectedAccountId: "c", changed: true });
  assert.equal(store.content().selected[P], "c");
});
