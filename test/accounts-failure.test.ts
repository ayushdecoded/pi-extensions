import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  classifyAssistantMessage,
  classifyError,
  classifyFailure,
  parseRateLimitResetHeader,
  parseRetryAfterHeader,
} from "../src/accounts/failure.ts";

const NOW = 1_700_000_000_000;

function errorMessage(message: string, stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.3-codex-spark",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: message,
    timestamp: NOW,
  };
}

test("codex 429 rate limit with retry-after header is retryable quota", () => {
  const c = classifyFailure(
    { status: 429, headers: { "retry-after": "30" }, message: "Rate limit reached for default-gpt-5.1, please retry your request later." },
    NOW,
  );
  assert.equal(c.kind, "quota");
  assert.equal(c.reason, "rate-limit");
  assert.equal(c.retryable, true);
  assert.equal(c.retry?.retryAfterMs, NOW + 30_000);
});

test("codex 429 usage exhaustion without guidance is not retryable", () => {
  const c = classifyFailure(
    { status: 429, message: "You have reached your usage limit for the day. Upgrade your plan to continue." },
    NOW,
  );
  assert.equal(c.kind, "quota");
  assert.equal(c.reason, "quota-exhaustion");
  assert.equal(c.retryable, false);
  assert.equal(c.retry, undefined);
});

test("codex auth failures are never retryable", () => {
  const c = classifyFailure({ status: 401, message: "Invalid authentication credentials" }, NOW);
  assert.equal(c.kind, "auth");
  assert.equal(c.retryable, false);
  const c2 = classifyFailure({ message: "Invalid API key provided" }, NOW);
  assert.equal(c2.kind, "auth");
  assert.equal(c2.retryable, false);
  const c3 = classifyFailure({ status: 403, message: "Forbidden" }, NOW);
  assert.equal(c3.kind, "auth");
});

test("codex 400 validation errors are other and not retryable", () => {
  const c = classifyFailure({ status: 400, message: "Bad Request: missing required field" }, NOW);
  assert.equal(c.kind, "other");
  assert.equal(c.retryable, false);
  assert.equal(c.retry, undefined);
});

test("codex 5xx failures are transient but never quota", () => {
  const c = classifyFailure({ status: 500, message: "Internal server error" }, NOW);
  assert.equal(c.kind, "other");
  assert.equal(c.reason, "transient");
  assert.equal(c.retryable, true);
  assert.notEqual(c.kind, "quota");
});

test("opencode-go usage-limit errors are quota exhaustion, not retryable", () => {
  const go = classifyFailure(
    { status: 429, message: '{"type":"GoUsageLimitError","message":"Free usage limit reached. Enable available balance usage to continue."}' },
    NOW,
  );
  assert.equal(go.kind, "quota");
  assert.equal(go.reason, "quota-exhaustion");
  assert.equal(go.retryable, false);

  const monthly = classifyFailure({ message: "Monthly usage limit reached. Enable available balance usage to continue." }, NOW);
  assert.equal(monthly.kind, "quota");
  assert.equal(monthly.retryable, false);

  const auth = classifyFailure({ status: 401, message: "OpenCode: invalid API key" }, NOW);
  assert.equal(auth.kind, "auth");
  assert.equal(auth.retryable, false);
});

test("opencode-go transient 429 is retryable quota with an absolute reset instant", () => {
  const c = classifyFailure(
    { status: 429, headers: { "x-ratelimit-reset": "3600" }, message: "Too many requests." },
    NOW,
  );
  assert.equal(c.kind, "quota");
  assert.equal(c.reason, "rate-limit");
  assert.equal(c.retryable, true);
  assert.equal(c.retry?.resetAtMs, NOW + 3_600_000);
});

test("github-style 403 rate-limit responses are quota, not auth", () => {
  const c = classifyFailure(
    { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" }, message: "API rate limit exceeded" },
    NOW,
  );
  assert.equal(c.kind, "quota");
  assert.equal(c.reason, "rate-limit");
  assert.equal(c.retryable, true);
  assert.equal(c.retry?.resetAtMs, NOW + 3_600_000);
});

test("settled assistant errors classify through classifyAssistantMessage", () => {
  const c = classifyAssistantMessage(errorMessage("429: Rate limit reached for default-gpt-5.1, please retry your request later"), NOW);
  assert.equal(c.kind, "quota");
  assert.equal(c.reason, "rate-limit");
  assert.equal(c.retryable, true);

  const auth = classifyAssistantMessage(errorMessage("OpenAI Codex (401): Invalid authentication credentials"), NOW);
  assert.equal(auth.kind, "auth");
  assert.equal(auth.retryable, false);

  const ok = classifyAssistantMessage({ ...errorMessage("ignored"), stopReason: "stop" }, NOW);
  assert.equal(ok.kind, "other");
  assert.equal(ok.retryable, false);
  assert.equal(ok.reason, "not-error");
});

test("explicit reset timestamps and durations in error text are parsed defensively", () => {
  const c = classifyFailure({ message: "Quota exhausted. Resets at 2026-01-15T12:30:00Z." }, NOW);
  assert.equal(c.kind, "quota");
  assert.equal(c.reason, "quota-exhaustion");
  assert.equal(c.retryable, true);
  assert.equal(c.retry?.resetAtMs, Date.parse("2026-01-15T12:30:00Z"));

  const c2 = classifyFailure({ message: "Weekly usage limit reached. Reset in 2 hours." }, NOW);
  assert.equal(c2.kind, "quota");
  assert.equal(c2.reason, "quota-exhaustion");
  assert.equal(c2.retryable, true);
  assert.equal(c2.retry?.resetAtMs, NOW + 2 * 3_600_000);

  const c3 = classifyFailure({ message: "Try again in 5 minutes." }, NOW);
  assert.equal(c3.kind, "other");
  assert.equal(c3.retryable, true); // explicit guidance makes the retry defensible
  assert.equal(c3.retry?.retryAfterMs, NOW + 5 * 60_000);
});

test("generic network and 5xx failures are never classified as quota", () => {
  const network = classifyFailure({ message: "fetch failed: Error: connect ECONNREFUSED" }, NOW);
  assert.equal(network.kind, "other");
  assert.equal(network.reason, "transient");
  assert.equal(network.retryable, true);

  const five = classifyFailure({ status: 503, message: "Service Unavailable" }, NOW);
  assert.equal(five.kind, "other");
  assert.equal(five.reason, "transient");
  assert.equal(five.retryable, true);

  const text500 = classifyFailure({ message: "HTTP 500 Internal Server Error" }, NOW);
  assert.equal(text500.kind, "other");
  assert.equal(text500.reason, "transient");
  assert.equal(text500.retryable, true);
});

test("conservative status extraction ignores stray numbers", () => {
  const c = classifyFailure({ message: "max_tokens must be 512 or fewer" }, NOW);
  assert.equal(c.kind, "other");
  assert.equal(c.retryable, false);

  const c2 = classifyFailure({ message: "Model gpt-5.1-preview returned 400: bad request" }, NOW);
  assert.equal(c2.kind, "other");
  assert.equal(c2.retryable, false);

  const c3 = classifyFailure({ message: "no status here at all" }, NOW);
  assert.equal(c3.kind, "other");
  assert.equal(c3.retryable, false);
  assert.equal(c3.retry, undefined);
});

test("retry-after header parses delta-seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterHeader("30", NOW), NOW + 30_000);
  assert.equal(parseRetryAfterHeader("0", NOW), NOW);
  assert.equal(parseRetryAfterHeader(["15"], NOW), NOW + 15_000);
  assert.equal(parseRetryAfterHeader("Wed, 21 Oct 2026 07:28:00 GMT", NOW), Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"));
  assert.equal(parseRetryAfterHeader("bogus", NOW), undefined);
  assert.equal(parseRetryAfterHeader(undefined, NOW), undefined);
});

test("x-ratelimit-reset header parses delta seconds, epoch seconds, and epoch ms", () => {
  assert.equal(parseRateLimitResetHeader("3600", NOW), NOW + 3_600_000);
  assert.equal(parseRateLimitResetHeader("0", NOW), NOW);
  const epochSeconds = 1_735_000_000;
  assert.equal(parseRateLimitResetHeader(String(epochSeconds), NOW), epochSeconds * 1000);
  const epochMs = 1_735_000_000_000;
  assert.equal(parseRateLimitResetHeader(String(epochMs), NOW), epochMs);
  assert.equal(parseRateLimitResetHeader("nope", NOW), undefined);
});

test("classifyError extracts status and headers from Error-like objects", () => {
  const err = new Error("429: Rate limit reached") as Error & { status: number };
  err.status = 429;
  const c = classifyError(err, NOW);
  assert.equal(c.kind, "quota");
  assert.equal(c.reason, "rate-limit");
  assert.equal(c.retryable, true);

  const err2 = Object.assign(new Error("Too many requests"), {
    statusCode: 429,
    headers: { "x-ratelimit-remaining": "0" },
  });
  const c2 = classifyError(err2, NOW);
  assert.equal(c2.kind, "quota");
  assert.equal(c2.retryable, true);
});
