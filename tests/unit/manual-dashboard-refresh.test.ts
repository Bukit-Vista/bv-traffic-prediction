import { describe, expect, it } from "vitest";
import {
  MANUAL_REFRESH_COOLDOWN_SECONDS,
  manualRefreshLockKey
} from "@/lib/snapshot/refresh-dashboard-cache";

describe("manual dashboard refresh safety", () => {
  it("uses a shared namespaced Redis lock", () => {
    expect(manualRefreshLockKey({
      REDIS_CACHE_NAMESPACE: "traffic-production"
    })).toBe("traffic-production:locks:dashboard-manual-refresh");
  });

  it("uses a fixed cross-process refresh cooldown", () => {
    expect(MANUAL_REFRESH_COOLDOWN_SECONDS).toBe(120);
  });
});
