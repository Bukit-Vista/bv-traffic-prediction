import { describe, expect, it } from "vitest";
import { clearRateLimitsForTests, enforceRateLimit, requireOperationsRole } from "@/lib/api/access-control";
import { resolveBoundedUtcRange } from "@/lib/api/validation";

describe("Step 3 API safety", () => {
  it("requires the configured operations bearer role", () => {
    const request = new Request("http://localhost/api/v1/operations/collectors", { headers: { authorization: "Bearer correct" } });
    expect(() => requireOperationsRole(request, {})).toThrow("not configured");
    expect(() => requireOperationsRole(request, { OPERATIONS_API_TOKEN: "wrong" })).toThrow("cannot access");
    expect(() => requireOperationsRole(request, { OPERATIONS_API_TOKEN: "correct" })).not.toThrow();
  });

  it("rate limits expensive resources by client and window", () => {
    clearRateLimitsForTests();
    const request = new Request("http://localhost/api", { headers: { "x-forwarded-for": "192.0.2.4" } });
    enforceRateLimit(request, "map", { maximum: 1, now: 1000, env: {} });
    expect(() => enforceRateLimit(request, "map", { maximum: 1, now: 1001, env: {} })).toThrow("Too many requests");
    expect(() => enforceRateLimit(request, "map", { maximum: 1, now: 61_001, env: {} })).not.toThrow();
  });

  it("defaults history to seven days and rejects an excessive range", () => {
    const range = resolveBoundedUtcRange({ limit: 168 }, Date.parse("2026-07-20T08:00:00Z"));
    expect(range).toEqual({ from: "2026-07-13T08:00:00.000Z", to: "2026-07-20T08:00:00.000Z", limit: 168 });
    expect(() => resolveBoundedUtcRange({
      from: "2026-01-01T00:00:00Z", to: "2026-07-20T00:00:00Z", limit: 168
    })).toThrow("93 days");
  });
});
