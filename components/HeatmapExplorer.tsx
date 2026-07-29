"use client";

import { useMemo, useState } from "react";
import { CalendarDays, RotateCcw, Search } from "lucide-react";
import { Heatmap } from "@/components/Heatmap";
import {
  MAX_HEATMAP_RANGE_DAYS,
  type RouteHeatmapRow
} from "@/lib/analytics/heatmap";

type HeatmapResponse = {
  startDate: string;
  endDate: string;
  days: number;
  heatmaps: DailyHeatmap[];
};

const DAY_MS = 86_400_000;

type DailyHeatmap = {
  date: string;
  rows: RouteHeatmapRow[];
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown;
};

function dateKeyToTime(dateKey: string) {
  return new Date(`${dateKey}T00:00:00.000Z`).getTime();
}

function addDays(dateKey: string, days: number) {
  if (!dateKey) {
    return "";
  }

  return new Date(dateKeyToTime(dateKey) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function diffDaysInclusive(startDate: string, endDate: string) {
  return Math.floor((dateKeyToTime(endDate) - dateKeyToTime(startDate)) / DAY_MS) + 1;
}

function rangeLabel(days: number) {
  return days === 1 ? "1 day" : `${days} days`;
}

function sortRows(rows: RouteHeatmapRow[], selectedHour: number | null) {
  if (selectedHour == null) {
    return rows;
  }

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const aScore = a.row.cells[selectedHour]?.score ?? null;
      const bScore = b.row.cells[selectedHour]?.score ?? null;

      if (aScore == null && bScore == null) {
        return a.index - b.index;
      }
      if (aScore == null) {
        return 1;
      }
      if (bScore == null) {
        return -1;
      }

      return bScore - aScore;
    })
    .map((item) => item.row);
}

export function HeatmapExplorer({
  initialHeatmaps,
  initialStartDate,
  initialEndDate,
  initialDays,
  retentionDays
}: {
  initialHeatmaps: DailyHeatmap[];
  initialStartDate: string;
  initialEndDate: string;
  initialDays: number;
  retentionDays: number;
}) {
  const [heatmaps, setHeatmaps] = useState(initialHeatmaps);
  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDate, setEndDate] = useState(initialEndDate);
  const [appliedStartDate, setAppliedStartDate] = useState(initialStartDate);
  const [appliedEndDate, setAppliedEndDate] = useState(initialEndDate);
  const [appliedDays, setAppliedDays] = useState(initialDays);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxEndDate = useMemo(
    () => (startDate ? addDays(startDate, MAX_HEATMAP_RANGE_DAYS - 1) : ""),
    [startDate]
  );

  const sortedHeatmaps = useMemo(
    () =>
      heatmaps.map((heatmap) => ({
        ...heatmap,
        rows: sortRows(heatmap.rows, selectedHour)
      })),
    [heatmaps, selectedHour]
  );

  function updateStartDate(value: string) {
    setStartDate(value);
    if (!value) {
      return;
    }

    const nextMaxEndDate = addDays(value, MAX_HEATMAP_RANGE_DAYS - 1);
    const days = diffDaysInclusive(value, endDate);

    if (days < 1 || days > MAX_HEATMAP_RANGE_DAYS) {
      setEndDate(value);
    } else if (endDate > nextMaxEndDate) {
      setEndDate(nextMaxEndDate);
    }
  }

  function updateEndDate(value: string) {
    setEndDate(value);
  }

  async function applyRange(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setError(null);

    if (!startDate || !endDate) {
      setError("Choose both start and end dates.");
      return;
    }

    const days = diffDaysInclusive(startDate, endDate);
    if (days < 1) {
      setError("End date must be on or after start date.");
      return;
    }
    if (days > MAX_HEATMAP_RANGE_DAYS) {
      setError(`Choose ${MAX_HEATMAP_RANGE_DAYS} days or less.`);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(
        `/api/heatmap?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(
          endDate
        )}`,
        { cache: "no-store" }
      );
      const payload = (await response.json()) as Partial<HeatmapResponse> & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to load heatmap range.");
      }

      setHeatmaps(payload.heatmaps ?? []);
      setAppliedStartDate(payload.startDate ?? startDate);
      setAppliedEndDate(payload.endDate ?? endDate);
      setAppliedDays(payload.days ?? days);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to load heatmap range."
      );
    } finally {
      setLoading(false);
    }
  }

  function resetToday() {
    setStartDate(initialStartDate);
    setEndDate(initialEndDate);
    setSelectedHour(null);
    void applyRangeFor(initialStartDate, initialEndDate);
  }

  async function applyRangeFor(nextStartDate: string, nextEndDate: string) {
    setError(null);
    setLoading(true);
    try {
      const response = await fetch(
        `/api/heatmap?start=${encodeURIComponent(
          nextStartDate
        )}&end=${encodeURIComponent(nextEndDate)}`,
        { cache: "no-store" }
      );
      const payload = (await response.json()) as Partial<HeatmapResponse> & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to load heatmap range.");
      }

      setHeatmaps(payload.heatmaps ?? []);
      setAppliedStartDate(payload.startDate ?? nextStartDate);
      setAppliedEndDate(payload.endDate ?? nextEndDate);
      setAppliedDays(payload.days ?? diffDaysInclusive(nextStartDate, nextEndDate));
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to load heatmap range."
      );
    } finally {
      setLoading(false);
    }
  }

  function selectHour(hour: number) {
    const update = () =>
      setSelectedHour((current) => (current === hour ? null : hour));
    const viewTransition = (document as ViewTransitionDocument).startViewTransition;

    if (viewTransition) {
      viewTransition(update);
      return;
    }

    update();
  }

  return (
    <div className="border border-line bg-white">
      <div className="grid gap-4 border-b border-line p-4 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <CalendarDays size={17} />
            <span>
              {appliedDays === 1
                ? `Showing date: ${appliedStartDate}`
                : `Comparing ${rangeLabel(appliedDays)}: ${appliedStartDate} to ${appliedEndDate}`}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted">
            Pick one WITA day for one heatmap, or compare up to 7 days as separate
            daily heatmaps. Click an hour header to rank routes by that hour.
          </p>
        </div>

        <form onSubmit={applyRange} className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Date</span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => updateStartDate(event.target.value)}
              className="focus-ring rounded border border-line px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Compare to</span>
            <input
              type="date"
              value={endDate}
              min={startDate}
              max={maxEndDate}
              onChange={(event) => updateEndDate(event.target.value)}
              className="focus-ring rounded border border-line px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="focus-ring inline-flex items-center gap-2 rounded bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            <Search size={17} />
            Apply
          </button>
          <button
            type="button"
            onClick={resetToday}
            disabled={loading}
            className="focus-ring inline-flex items-center gap-2 rounded border border-line px-3 py-2 text-sm font-medium text-ink disabled:opacity-60"
          >
            <RotateCcw size={17} />
            Today
          </button>
        </form>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-panel px-4 py-2 text-xs text-muted">
        <span>Stored retention: {retentionDays} days</span>
        <span>Live samples only; empty cells mean missing data</span>
        <span>
          {selectedHour == null
            ? "Default route order"
            : `Sorted by ${selectedHour.toString().padStart(2, "0")}:00 WITA`}
        </span>
      </div>

      {error ? (
        <div className="border-b border-line bg-red-50 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <div className={loading ? "opacity-60" : undefined}>
        <div className="grid gap-6">
          {sortedHeatmaps.map((heatmap) => (
            <section key={heatmap.date} className="border-b border-line last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <h3 className="text-sm font-semibold text-ink">
                  {heatmap.date} WITA
                </h3>
                <span className="text-xs text-muted">
                  {selectedHour == null
                    ? "Default route order"
                    : `Ranked by ${selectedHour
                        .toString()
                        .padStart(2, "0")}:00 WITA`}
                </span>
              </div>
              <Heatmap
                rows={heatmap.rows}
                selectedHour={selectedHour}
                framed={false}
                transitionKey={heatmap.date}
                onHourSelect={selectHour}
              />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
