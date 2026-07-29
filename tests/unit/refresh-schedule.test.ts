import { describe, expect, it } from "vitest";
import {
  DASHBOARD_RECOVERY_RETRY_MS,
  DASHBOARD_VERSION_POLL_MS,
  nextAlignedRefreshDelayMs,
  nextDashboardRefreshDelayMs
} from "@/lib/snapshot/refresh-schedule";

describe("aligned refresh schedule", () => {
  it("runs 12 minutes after each half-hour boundary", () => {
    expect(nextAlignedRefreshDelayMs(
      Date.parse("2026-07-29T12:00:00.000Z"),
      30,
      12
    )).toBe(12 * 60_000);
    expect(nextAlignedRefreshDelayMs(
      Date.parse("2026-07-29T12:11:30.000Z"),
      30,
      12
    )).toBe(30_000);
    expect(nextAlignedRefreshDelayMs(
      Date.parse("2026-07-29T12:12:00.000Z"),
      30,
      12
    )).toBe(30 * 60_000);
    expect(nextAlignedRefreshDelayMs(
      Date.parse("2026-07-29T12:42:01.000Z"),
      30,
      12
    )).toBe(29 * 60_000 + 59_000);
  });

  it("rejects an offset outside the interval", () => {
    expect(() => nextAlignedRefreshDelayMs(Date.now(), 30, 30)).toThrow(
      "Refresh schedule configuration is invalid."
    );
  });

  it("polls continuously and retries failures sooner", () => {
    expect(nextDashboardRefreshDelayMs(false)).toBe(DASHBOARD_VERSION_POLL_MS);
    expect(nextDashboardRefreshDelayMs(true)).toBe(DASHBOARD_RECOVERY_RETRY_MS);
    expect(DASHBOARD_RECOVERY_RETRY_MS).toBeLessThan(DASHBOARD_VERSION_POLL_MS);
  });
});
