import assert from "node:assert/strict";
import { test } from "vitest";
import { claudeUsage, codexUsage, fetchProviderUsage } from "./usage.js";

test("Codex labels windows by duration, not response position", () => {
  const usage = codexUsage({
    rate_limit: {
      primary_window: { used_percent: 72, limit_window_seconds: 604800, reset_at: 1790747750 },
      secondary_window: { used_percent: 19, limit_window_seconds: 18000, reset_at: 1790200000 },
    },
  });
  assert.equal(usage?.fiveHour?.usedPercent, 19);
  assert.equal(usage?.weekly?.usedPercent, 72);
  assert.equal(usage?.fable, null);
});

test("Claude finds the separate Fable weekly limit", () => {
  const usage = claudeUsage({
    five_hour: { utilization: 12, resets_at: "2026-09-23T23:39:59Z" },
    seven_day: { utilization: 77, resets_at: "2026-09-26T19:59:59Z" },
    limits: [
      { kind: "other" },
      {
        kind: "weekly_scoped",
        percent: 93,
        resets_at: "2026-09-26T19:59:59Z",
        scope: { model: { id: null, display_name: "Fable" } },
      },
    ],
  });
  assert.equal(usage?.fiveHour?.usedPercent, 12);
  assert.equal(usage?.weekly?.usedPercent, 77);
  assert.equal(usage?.fable?.usedPercent, 93);
});

test("usage fetch sends the stored credential only to its provider", async () => {
  const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(input, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret");
    return Response.json({
      rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800 } },
    });
  }) as typeof fetch;
  const usage = await fetchProviderUsage(
    "codex",
    JSON.stringify({ tokens: { access_token: "secret" } }),
    mock,
  );
  assert.equal(usage?.weekly?.usedPercent, 20);
  assert.equal(usage?.fiveHour, null);
});
