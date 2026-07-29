"use client";

import { formatCongestionScore } from "@/lib/analytics/congestion";
import type { HeatmapCell } from "@/lib/analytics/heatmap";
import type { RouteHeatmapRow } from "@/lib/analytics/heatmap";

const hours = Array.from({ length: 24 }, (_, index) => index);

function cellClass(score: number | null | undefined) {
  return score == null
    ? "bg-slate-100"
    : "shadow-inner ring-1 ring-inset ring-black/5";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mixColor(
  start: [number, number, number],
  end: [number, number, number],
  amount: number
) {
  const t = clamp(amount, 0, 1);
  const [r1, g1, b1] = start;
  const [r2, g2, b2] = end;
  return `rgb(${Math.round(r1 + (r2 - r1) * t)} ${Math.round(
    g1 + (g2 - g1) * t
  )} ${Math.round(b1 + (b2 - b1) * t)})`;
}

function cellStyle(score: number | null | undefined): React.CSSProperties {
  if (score == null || Number.isNaN(score)) {
    return {};
  }

  if (score <= 1.15) {
    return {
      backgroundColor: mixColor([209, 250, 229], [16, 185, 129], (score - 1) / 0.15)
    };
  }

  if (score <= 1.35) {
    return {
      backgroundColor: mixColor(
        [254, 243, 199],
        [245, 158, 11],
        (score - 1.15) / 0.2
      )
    };
  }

  return {
    backgroundColor: mixColor([254, 202, 202], [220, 38, 38], (score - 1.35) / 0.65)
  };
}

function sourceSummary(cell: HeatmapCell) {
  const parts = [];
  if (cell.liveCount > 0) {
    parts.push(
      `${cell.liveCount} live sample${cell.liveCount === 1 ? "" : "s"}`
    );
  }
  if (cell.historicalCount > 0) {
    parts.push(
      `${cell.historicalCount} historical backfill sample${
        cell.historicalCount === 1 ? "" : "s"
      }`
    );
  }
  return parts.join(", ");
}

export function Heatmap({
  rows,
  selectedHour,
  onHourSelect,
  framed = true,
  transitionKey = "default"
}: {
  rows: RouteHeatmapRow[];
  selectedHour?: number | null;
  onHourSelect?: (hour: number) => void;
  framed?: boolean;
  transitionKey?: string;
}) {
  if (rows.length === 0) {
    return (
      <div
        className={`bg-white p-6 text-sm text-muted ${
          framed ? "border border-line" : ""
        }`}
      >
        No active routes available for heatmap.
      </div>
    );
  }

  return (
    <div
      className={`overflow-x-auto bg-white ${framed ? "border border-line" : ""}`}
    >
      <table className="min-w-[980px] border-collapse text-xs">
        <thead>
          <tr className="bg-panel text-muted">
            <th className="sticky left-0 z-10 w-56 bg-panel px-3 py-2 text-left">
              Route
            </th>
            {hours.map((hour) => (
              <th key={hour} className="w-8 px-1 py-2 text-center font-medium">
                <button
                  type="button"
                  onClick={() => onHourSelect?.(hour)}
                  className={`focus-ring h-7 w-7 rounded-sm ${
                    selectedHour === hour
                      ? "bg-ink text-white"
                      : "hover:bg-white hover:text-ink"
                  }`}
                  title={`Sort by ${hour.toString().padStart(2, "0")}:00 WITA`}
                >
                  {hour.toString().padStart(2, "0")}
                </button>
              </th>
          ))}
        </tr>
      </thead>
      <tbody>
          {rows.map((row) => (
            <tr
              key={row.route.id}
              className="border-t border-line transition-colors duration-300 ease-out hover:bg-panel"
              style={
                {
                  viewTransitionName: `heatmap-${transitionKey}-route-${row.route.id}`
                } as React.CSSProperties
              }
            >
              <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-medium">
                <span className="block truncate">
                  {row.route.originLabel} to {row.route.destinationLabel}
                </span>
              </th>
              {row.cells.map((cell, hour) => (
                <td key={hour} className="p-1">
                  <div
                    className={`h-7 w-7 rounded-[2px] transition-[background-color,box-shadow,opacity] duration-300 ${cellClass(
                      cell?.score
                    )}`}
                    style={cellStyle(cell?.score)}
                    title={
                      cell
                        ? `${hour.toString().padStart(2, "0")}:00 WITA, ${formatCongestionScore(
                            cell.score
                          )}, ${sourceSummary(cell)}`
                        : `${hour.toString().padStart(2, "0")}:00 WITA, no samples`
                    }
                    aria-label={
                      cell
                        ? `${hour.toString().padStart(2, "0")}:00 WITA ${formatCongestionScore(
                            cell.score
                          )}`
                        : `${hour.toString().padStart(2, "0")}:00 WITA no sample`
                    }
                  >
                    <span className="sr-only">
                      {cell ? formatCongestionScore(cell.score) : "Missing"}
                    </span>
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
