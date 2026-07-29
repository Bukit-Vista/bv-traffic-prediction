import Link from "next/link";
import { formatAppDateTime } from "@/components/format";
import { formatCongestionScore } from "@/lib/analytics/congestion";
import { formatDuration } from "@/lib/analytics/duration";
import type { RankedRoute } from "@/lib/analytics/ranking";

function statusClass(status: RankedRoute["status"]) {
  if (status === "fresh") {
    return "bg-green-50 text-positive";
  }
  if (status === "stale") {
    return "bg-amber-50 text-warning";
  }
  return "bg-slate-100 text-muted";
}

export function Leaderboard({ rows }: { rows: RankedRoute[] }) {
  if (rows.length === 0) {
    return (
      <div className="border border-line bg-white p-6 text-sm text-muted">
        No active routes yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border border-line bg-white">
      <table className="min-w-full divide-y divide-line text-sm">
        <thead className="bg-panel text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-3">Rank</th>
            <th className="px-4 py-3">Route</th>
            <th className="px-4 py-3">Current</th>
            <th className="px-4 py-3">Normal</th>
            <th className="px-4 py-3">Score</th>
            <th className="px-4 py-3">Collected WITA</th>
            <th className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row.route.id} className="hover:bg-panel">
              <td className="whitespace-nowrap px-4 py-3 font-semibold">
                {row.rank ?? "-"}
              </td>
              <td className="min-w-64 px-4 py-3">
                <Link
                  href={`/routes/${row.route.slug}`}
                  className="font-medium text-ink hover:underline"
                >
                  {row.route.originLabel} to {row.route.destinationLabel}
                </Link>
                <p className="mt-1 text-xs text-muted">{row.route.category}</p>
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                {formatDuration(row.sample?.trafficDurationSeconds)}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                {formatDuration(row.sample?.durationSeconds)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 font-medium">
                {formatCongestionScore(row.score)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-muted">
                {row.sample ? formatAppDateTime(row.sample.sampleHour) : "-"}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                <span
                  className={`inline-flex rounded px-2 py-1 text-xs font-medium capitalize ${statusClass(
                    row.status
                  )}`}
                >
                  {row.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
