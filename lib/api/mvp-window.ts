const HOUR_MS = 3_600_000;

export const MVP_WINDOW_HOURS = 12;
export const MVP_FLOW_INTERVAL_MINUTES = 30;
export const MVP_ROUTES_PER_SLOT = 14;

export type MvpUtcWindow = {
  startUtc: string;
  endExclusiveUtc: string;
  windowHours: number;
};

function configuredMaximumHours(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.MVP_HISTORY_MAX_HOURS ?? MVP_WINDOW_HOURS);
  return Number.isInteger(value) && value >= MVP_WINDOW_HOURS && value <= 168
    ? value
    : MVP_WINDOW_HOURS;
}

export function completedUtcHourWindow(
  hours = MVP_WINDOW_HOURS,
  now: number | Date = Date.now(),
  maximumHours = configuredMaximumHours()
): MvpUtcWindow {
  if (!Number.isInteger(hours) || hours < 1 || hours > maximumHours) {
    throw new RangeError(`hours must be an integer between 1 and ${maximumHours}`);
  }
  const end = new Date(now);
  if (!Number.isFinite(end.getTime())) throw new RangeError("now must be a valid date");
  end.setUTCMinutes(0, 0, 0);
  return {
    startUtc: new Date(end.getTime() - hours * HOUR_MS).toISOString(),
    endExclusiveUtc: end.toISOString(),
    windowHours: hours
  };
}

export function resolveMvpUtcWindow(
  input: { hours?: number; from?: string; to?: string },
  now: number | Date = Date.now(),
  maximumHours = configuredMaximumHours()
): MvpUtcWindow {
  if (!input.from && !input.to) {
    return completedUtcHourWindow(input.hours ?? MVP_WINDOW_HOURS, now, maximumHours);
  }
  if (!input.from || !input.to) throw new RangeError("from and to must be provided together");
  const start = new Date(input.from);
  const end = new Date(input.to);
  const duration = end.getTime() - start.getTime();
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError("from must be before to");
  if (start.getUTCMinutes() || start.getUTCSeconds() || start.getUTCMilliseconds() ||
      end.getUTCMinutes() || end.getUTCSeconds() || end.getUTCMilliseconds()) {
    throw new RangeError("from and to must align to UTC clock hours");
  }
  const hours = duration / HOUR_MS;
  if (!Number.isInteger(hours) || hours > maximumHours) {
    throw new RangeError(`history window cannot exceed ${maximumHours} hours`);
  }
  return { startUtc: start.toISOString(), endExclusiveUtc: end.toISOString(), windowHours: hours };
}

export function expectedSlots(window: MvpUtcWindow, intervalMinutes: 30 | 60) {
  const slots: string[] = [];
  const step = intervalMinutes * 60_000;
  for (let time = new Date(window.startUtc).getTime(); time < new Date(window.endExclusiveUtc).getTime(); time += step) {
    slots.push(new Date(time).toISOString());
  }
  return slots;
}

export function coverageForSlots(expected: readonly string[], present: Iterable<string>) {
  const available = new Set(present);
  const missingSlotsUtc = expected.filter((slot) => !available.has(slot));
  const presentSlots = expected.length - missingSlotsUtc.length;
  return {
    expectedSlots: expected.length,
    presentSlots,
    coverage: expected.length ? presentSlots / expected.length : 0,
    missingSlotsUtc
  };
}
