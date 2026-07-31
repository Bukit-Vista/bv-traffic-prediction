import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  redisCacheHealth,
  trafficSnapshotReadiness,
  snapshotWorkerHeartbeatHealth,
  queryRows
} = vi.hoisted(() => ({
  redisCacheHealth: vi.fn(),
  trafficSnapshotReadiness: vi.fn(),
  snapshotWorkerHeartbeatHealth: vi.fn(),
  queryRows: vi.fn(() => {
    throw new Error("Health readiness must not query MySQL.");
  })
}));

vi.mock("@/lib/cache/redis-json", () => ({ redisCacheHealth }));
vi.mock("@/lib/snapshot/traffic-snapshot", () => ({ trafficSnapshotReadiness }));
vi.mock("@/lib/snapshot/worker-heartbeat", () => ({ snapshotWorkerHeartbeatHealth }));
vi.mock("@/lib/db/mysql", () => ({ queryRows }));

import { GET } from "@/app/api/v1/health/route";

describe("Redis-first health readiness", () => {
  beforeEach(() => {
    redisCacheHealth.mockResolvedValue({ status: "ok", required: true });
    trafficSnapshotReadiness.mockResolvedValue({
      status: "ok",
      reason: "ready",
      version: "snapshot-version",
      createdAtUtc: "2026-07-31T08:00:00.000Z"
    });
    snapshotWorkerHeartbeatHealth.mockResolvedValue({
      status: "ok",
      heartbeat: {
        phase: "waiting",
        heartbeatAtUtc: "2026-07-31T08:00:00.000Z",
        lastSuccessAtUtc: "2026-07-31T08:00:00.000Z"
      }
    });
  });

  it("reports readiness without touching MySQL", async () => {
    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      application: "ok",
      database: "not_checked",
      redis: "ok",
      snapshot: { status: "ok", reason: "ready" },
      worker: { status: "ok" }
    });
    expect(queryRows).not.toHaveBeenCalled();
  });

  it("reports a stale worker without taking a valid Redis snapshot out of service", async () => {
    snapshotWorkerHeartbeatHealth.mockResolvedValue({
      status: "stale",
      heartbeat: { phase: "waiting", heartbeatAtUtc: "2026-07-31T07:00:00.000Z" }
    });

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.application).toBe("ok");
    expect(payload.data.worker.status).toBe("stale");
    expect(queryRows).not.toHaveBeenCalled();
  });

  it("fails readiness when the active snapshot is incomplete", async () => {
    trafficSnapshotReadiness.mockResolvedValue({
      status: "unavailable",
      reason: "tile_missing",
      version: "snapshot-version",
      createdAtUtc: "2026-07-31T08:00:00.000Z"
    });

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.data.application).toBe("unavailable");
    expect(payload.data.snapshot.reason).toBe("tile_missing");
  });
});
