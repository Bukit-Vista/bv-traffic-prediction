import { describe, expect, it, vi } from "vitest";
import { ApiUnavailableError } from "@/lib/api/core";

const { refreshDashboardCache, requireOperationsRole, enforceRateLimit } = vi.hoisted(() => ({
  refreshDashboardCache: vi.fn(),
  requireOperationsRole: vi.fn(),
  enforceRateLimit: vi.fn()
}));

vi.mock("@/lib/snapshot/refresh-dashboard-cache", () => ({ refreshDashboardCache }));
vi.mock("@/lib/api/access-control", () => ({ requireOperationsRole, enforceRateLimit }));

import { POST } from "@/app/api/v1/dashboard/refresh/route";

describe("dashboard refresh route", () => {
  it("returns 503 instead of reporting success when Redis publication fails", async () => {
    refreshDashboardCache.mockRejectedValueOnce(
      new ApiUnavailableError("The dashboard refresh did not publish a complete Redis snapshot.")
    );

    const response = await POST(new Request("http://localhost/api/v1/dashboard/refresh", {
      method: "POST"
    }));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("DATA_UNAVAILABLE");
    expect(payload.error.retryable).toBe(true);
  });
});
