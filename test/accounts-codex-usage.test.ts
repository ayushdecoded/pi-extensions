import assert from "node:assert/strict";
import { test } from "node:test";
import type { LimitWindow } from "../src/accounts/types.ts";
import {
  CODEX_USAGE_URL,
  fetchCodexUsage,
  parseCodexUsagePayload,
} from "../src/accounts/codex-usage.ts";

const NOW = 1_735_000_000_000;

const iso = (ms: number): string => new Date(ms).toISOString();

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === target)?.[1];
}

function makeJwt(accountId: string): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("parses rate_limit primary/secondary windows with all snake fields", () => {
  const windows = parseCodexUsagePayload(
    {
      rate_limit: {
        primary: { used_percent: 12.5, limit_window_seconds: 3600, reset_at: 1_735_000_000 },
        secondary: { used_percent: 3, limit_window_seconds: 3600, reset_at: 1_735_000_000_000 },
      },
    },
    NOW,
  );
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], {
    name: "primary",
    usedPercent: 12.5,
    windowSeconds: 3600,
    resetAt: iso(1_735_000_000 * 1000),
    updatedAt: iso(NOW),
  });
  assert.equal(windows[1].name, "secondary");
  assert.equal(windows[1].usedPercent, 3);
  assert.equal(windows[1].resetAt, iso(1_735_000_000_000));
  assert.equal(windows[1].updatedAt, iso(NOW));
});

test("parses camelCase rateLimits containers and fields", () => {
  const windows = parseCodexUsagePayload(
    {
      rateLimits: {
        primaryWindow: { usedPercent: 40, limitWindowSeconds: 1800 },
        secondaryWindow: { usedPercent: "5" },
      },
    },
    NOW,
  );
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], {
    name: "primary",
    usedPercent: 40,
    windowSeconds: 1800,
    updatedAt: iso(NOW),
  });
  assert.equal(windows[1].name, "secondary");
  assert.equal(windows[1].usedPercent, 5);
  assert.equal(windows[1].windowSeconds, undefined);
  assert.ok(!("windowSeconds" in windows[1]));
});

test("merges primary_window and primary variants into one primary window", () => {
  const windows = parseCodexUsagePayload(
    {
      rate_limit: {
        primary_window: { limit_window_seconds: 3600 },
        primary: { used_percent: 66, reset_at: 1_735_000_000 },
        secondary_window: { limit_window_seconds: 604_800 },
      },
    },
    NOW,
  );
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], {
    name: "primary",
    usedPercent: 66,
    windowSeconds: 3600,
    resetAt: iso(1_735_000_000 * 1000),
    updatedAt: iso(NOW),
  });
  assert.equal(windows[1].name, "secondary");
  assert.equal(windows[1].windowSeconds, 604_800);
  assert.equal(windows[1].usedPercent, undefined);
});

test("null and missing windows are skipped; empty payloads yield no windows", () => {
  assert.deepEqual(parseCodexUsagePayload(null, NOW), []);
  assert.deepEqual(parseCodexUsagePayload("not-an-object", NOW), []);
  assert.deepEqual(parseCodexUsagePayload({}, NOW), []);
  assert.deepEqual(parseCodexUsagePayload({ rate_limit: { primary: null, secondary: null } }, NOW), []);
  assert.deepEqual(parseCodexUsagePayload({ rate_limit: null, additional_rate_limits: null }, NOW), []);
  // a window with nothing parseable is skipped too
  assert.deepEqual(parseCodexUsagePayload({ rate_limit: { primary: { foo: "bar" } } }, NOW), []);
});

test("additional_rate_limits entries keep supplied human labels", () => {
  const windows = parseCodexUsagePayload(
    {
      additional_rate_limits: [
        { name: "Weekly GPT-5", used_percent: 42, limit_window_seconds: 604_800 },
        { label: "Monthly", used_percent: 87, limit_window_seconds: 2_592_000 },
      ],
      additionalRateLimits: [{ name: "ignored camel twin" }],
    },
    NOW,
  );
  assert.deepEqual(
    windows.map((w) => w.name),
    ["Weekly GPT-5", "Monthly"],
  );
});

test("unlabeled additional windows are named from their window length", () => {
  const windows = parseCodexUsagePayload(
    {
      additional_rate_limits: [
        { used_percent: 10, limit_window_seconds: 18_000 },
        { used_percent: 20, limit_window_seconds: 604_800 },
        { used_percent: 30, limit_window_seconds: 2_592_000 },
        { used_percent: 40, limit_window_seconds: 86400 },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    windows.map((w) => [w.name, w.windowSeconds]),
    [
      ["5h", 18_000],
      ["weekly", 604_800],
      ["monthly", 2_592_000],
      ["24h", 86400],
    ],
  );
});

test("colliding names are disambiguated with numbered suffixes", () => {
  const windows = parseCodexUsagePayload(
    {
      additional_rate_limits: [
        { used_percent: 1, limit_window_seconds: 604_800 },
        { used_percent: 2, limit_window_seconds: 604_800 },
        { name: "Weekly GPT-5", used_percent: 3 },
        { name: "Weekly GPT-5", used_percent: 4 },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    windows.map((w) => w.name),
    ["weekly", "weekly (2)", "Weekly GPT-5", "Weekly GPT-5 (2)"],
  );
});

test("reset-after durations resolve relative to the fetched timestamp and move with it", () => {
  const windows = parseCodexUsagePayload(
    {
      rate_limit: { primary: { used_percent: 50, reset_after: 3_600 } },
      additional_rate_limits: [{ name: "Weekly", used_percent: 1, reset_after: "2h" }],
    },
    NOW,
  );
  assert.equal(windows[0].resetAt, iso(NOW + 3_600_000));
  assert.equal(windows[1].resetAt, iso(NOW + 2 * 3_600_000));

  // the same relative payload fetched later moves the reset instant
  const later = parseCodexUsagePayload(
    { rate_limit: { primary: { used_percent: 50, reset_after: 3_600 } } },
    NOW + 60_000,
  );
  assert.equal(later[0].resetAt, iso(NOW + 60_000 + 3_600_000));
});

test("reset_at accepts epoch seconds, epoch ms, and ISO timestamps", () => {
  const windows = parseCodexUsagePayload(
    {
      rate_limit: {
        primary: { used_percent: 1, reset_at: 1_735_000_000 },
        secondary: { used_percent: 2, reset_at: "1735000000000" },
      },
      additional_rate_limits: [{ name: "Weekly", used_percent: 3, reset_at: "2025-01-15T12:30:00.000Z" }],
    },
    NOW,
  );
  assert.equal(windows[0].resetAt, iso(1_735_000_000 * 1000));
  assert.equal(windows[1].resetAt, iso(1_735_000_000_000));
  assert.equal(windows[2].resetAt, "2025-01-15T12:30:00.000Z");
});

test("resets are optional and omitted when absent or unparseable", () => {
  const windows = parseCodexUsagePayload(
    {
      rate_limit: { primary: { used_percent: 10 } },
      additional_rate_limits: [
        { name: "bad-at", used_percent: 20, reset_at: "not-a-date" },
        { name: "bad-after", used_percent: 21, reset_after: "soon" },
      ],
    },
    NOW,
  );
  assert.equal(windows.length, 3);
  for (const window of windows) {
    assert.equal(window.resetAt, undefined);
    assert.ok(!("resetAt" in window));
  }
});

test("malformed percentages are omitted instead of guessed", () => {
  const windows = parseCodexUsagePayload(
    {
      additional_rate_limits: [
        { name: "ok", used_percent: "42.5%", limit_window_seconds: 60 },
        { name: "bare", used_percent: "50", limit_window_seconds: 60 },
        { name: "non-numeric", used_percent: "abc", limit_window_seconds: 60 },
        { name: "negative", used_percent: -5, limit_window_seconds: 60 },
        { name: "over", used_percent: 150, limit_window_seconds: 60 },
        { name: "nan", used_percent: Number.NaN, limit_window_seconds: 60 },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    windows.map((w) => w.usedPercent),
    [42.5, 50, undefined, undefined, undefined, undefined],
  );
  // windows with no usable data at all are dropped entirely
  assert.deepEqual(parseCodexUsagePayload({ additional_rate_limits: [{ name: "x", used_percent: "nope" }] }, NOW), []);
});

test("malformed window lengths are omitted", () => {
  const windows = parseCodexUsagePayload(
    {
      additional_rate_limits: [
        { name: "zero", used_percent: 1, limit_window_seconds: 0 },
        { name: "negative", used_percent: 1, limit_window_seconds: -3600 },
        { name: "text", used_percent: 1, window_seconds: "abc" },
        { name: "string-ok", used_percent: 1, window_seconds: "1800" },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    windows.map((w) => w.windowSeconds),
    [undefined, undefined, undefined, 1800],
  );
});

test("windows carry the injected fetched timestamp as updatedAt", () => {
  const windows = parseCodexUsagePayload(
    { rate_limit: { primary: { used_percent: 5 } } },
    NOW,
  );
  assert.equal(windows[0].updatedAt, iso(NOW));
  // default clock injects a real, parseable timestamp
  const fresh = parseCodexUsagePayload({ rate_limit: { primary: { used_percent: 5 } } });
  assert.ok(!Number.isNaN(Date.parse(fresh[0].updatedAt)));
});

test("fetchCodexUsage builds codex headers, posts to the usage URL, and parses", async () => {
  const payload = {
    rate_limit: {
      primary: { used_percent: 10, limit_window_seconds: 3600, reset_at: 1_735_000_000 },
    },
    additional_rate_limits: [{ name: "Weekly GPT-5", used_percent: 42, limit_window_seconds: 604_800 }],
  };
  let capturedUrl: string | undefined;
  let capturedHeaders: Record<string, string> | undefined;
  const fetchFn = async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedHeaders = init?.headers as Record<string, string>;
    return jsonResponse(payload);
  };

  const windows = await fetchCodexUsage({
    apiKey: "test-token",
    headers: { "chatgpt-account-id": "acct-1" },
    fetch: fetchFn as typeof fetch,
    now: NOW,
  });

  assert.equal(capturedUrl, CODEX_USAGE_URL);
  assert.equal(header(capturedHeaders, "Authorization"), "Bearer test-token");
  assert.equal(header(capturedHeaders, "Accept"), "application/json");
  assert.equal(header(capturedHeaders, "OpenAI-Beta"), "codex-1");
  assert.equal(header(capturedHeaders, "originator"), "Pi");
  assert.equal(header(capturedHeaders, "ChatGPT-Account-ID"), "acct-1");
  assert.deepEqual(
    windows.map((w: LimitWindow) => [w.name, w.usedPercent]),
    [
      ["primary", 10],
      ["Weekly GPT-5", 42],
    ],
  );
  assert.equal(windows[0].updatedAt, iso(NOW));
});

test("fetchCodexUsage drops null header markers and keeps an explicit account header", async () => {
  let capturedHeaders: Record<string, string> | undefined;
  const fetchFn = async (_url: unknown, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return jsonResponse({ rate_limit: { primary: { used_percent: 1 } } });
  };

  await fetchCodexUsage({
    apiKey: "test-token",
    headers: { "x-remove-me": null, "ChatGPT-Account-ID": "configured" },
    fetch: fetchFn as typeof fetch,
  });

  assert.equal(capturedHeaders?.["x-remove-me"], undefined);
  assert.equal(capturedHeaders?.["ChatGPT-Account-ID"], "configured");
});

test("fetchCodexUsage derives the account id from the JWT when not supplied", async () => {
  let capturedHeaders: Record<string, string> | undefined;
  const fetchFn = async (_url: unknown, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return jsonResponse({});
  };

  await fetchCodexUsage({ apiKey: makeJwt("acct-jwt-9"), fetch: fetchFn as typeof fetch });

  assert.equal(capturedHeaders?.["ChatGPT-Account-ID"], "acct-jwt-9");
  assert.equal(capturedHeaders?.["Authorization"], `Bearer ${makeJwt("acct-jwt-9")}`);
});

test("HTTP errors are concise and never include response bodies or tokens", async () => {
  const secretBody = "You are not allowed. token=SECRET_ABC123";
  const fetchFn = async () => jsonResponse(secretBody, 429);

  await assert.rejects(
    fetchCodexUsage({ apiKey: "test-token", fetch: fetchFn as typeof fetch }),
    /Codex usage request failed: HTTP 429/,
  );
  await assert.rejects(fetchCodexUsage({ apiKey: "test-token", fetch: fetchFn as typeof fetch }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes("SECRET_ABC123"), "error must not leak the response body");
    assert.ok(!err.message.includes("test-token"), "error must not leak the token");
    return true;
  });

  const five = async () => jsonResponse("boom", 500);
  await assert.rejects(
    fetchCodexUsage({ apiKey: "test-token", fetch: five as typeof fetch }),
    /Codex usage request failed: HTTP 500/,
  );
});

test("unparseable response bodies surface a concise error", async () => {
  const fetchFn = async () => jsonResponse("<html>oops</html>", 200);
  await assert.rejects(
    fetchCodexUsage({ apiKey: "test-token", fetch: fetchFn as typeof fetch }),
    /unparseable body/,
  );
  await assert.rejects(fetchCodexUsage({ apiKey: "test-token", fetch: fetchFn as typeof fetch }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes("<html>"), "error must not echo the body");
    return true;
  });
});
