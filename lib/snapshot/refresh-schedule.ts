export function nextAlignedRefreshDelayMs(
  nowMs: number,
  intervalMinutes: number,
  offsetMinutes: number
) {
  if (
    !Number.isFinite(nowMs) ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    !Number.isInteger(offsetMinutes) ||
    offsetMinutes < 0 ||
    offsetMinutes >= intervalMinutes
  ) {
    throw new Error("Refresh schedule configuration is invalid.");
  }
  const intervalMs = intervalMinutes * 60_000;
  const offsetMs = offsetMinutes * 60_000;
  const positionMs = ((nowMs % intervalMs) + intervalMs) % intervalMs;
  const delayMs = offsetMs - positionMs;
  return delayMs > 0 ? delayMs : delayMs + intervalMs;
}

export const DASHBOARD_VERSION_POLL_MS = 30_000;
export const DASHBOARD_RECOVERY_RETRY_MS = 10_000;
export const SNAPSHOT_FAILURE_RETRY_BASE_MS = 5 * 60_000;
export const SNAPSHOT_FAILURE_RETRY_MAX_MS = 30 * 60_000;

export function nextDashboardRefreshDelayMs(failed: boolean) {
  return failed ? DASHBOARD_RECOVERY_RETRY_MS : DASHBOARD_VERSION_POLL_MS;
}

export function nextSnapshotFailureDelayMs(
  consecutiveFailures: number,
  intervalMinutes: number
) {
  if (
    !Number.isInteger(consecutiveFailures) ||
    consecutiveFailures < 1 ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 1
  ) {
    throw new Error("Snapshot failure retry configuration is invalid.");
  }
  const exponent = Math.min(consecutiveFailures - 1, 10);
  return Math.min(
    intervalMinutes * 60_000,
    SNAPSHOT_FAILURE_RETRY_MAX_MS,
    SNAPSHOT_FAILURE_RETRY_BASE_MS * 2 ** exponent
  );
}
