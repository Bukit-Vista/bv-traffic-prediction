import { formatAppDateTime, formatDistanceToNow } from "@/components/format";
import type { IngestionRun } from "@/lib/db/types";

export function CollectionStatus({
  run,
  generatedAt
}: {
  run: IngestionRun | null;
  generatedAt: string;
}) {
  if (!run) {
    return (
      <div className="border border-line bg-white p-4">
        <p className="text-sm font-medium">No ingestion run recorded</p>
        <p className="mt-1 text-sm text-muted">
          No completed data update is available yet.
        </p>
      </div>
    );
  }

  const tone =
    run.status === "success"
      ? "text-positive"
      : run.status === "partial"
        ? "text-warning"
        : run.status === "running"
          ? "text-muted"
          : "text-danger";

  return (
    <div className="grid gap-4 border border-line bg-white p-4 md:grid-cols-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Latest run</p>
        <p className={`mt-1 font-semibold capitalize ${tone}`}>
          {run.status}
        </p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Run hour WITA</p>
        <p className="mt-1 font-medium">{formatAppDateTime(run.sampleHour)}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Result</p>
        <p className="mt-1 font-medium">
          {run.routeSuccessCount} ok / {run.routeFailureCount} failed
        </p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Dashboard age</p>
        <p className="mt-1 font-medium">{formatDistanceToNow(generatedAt)}</p>
      </div>
    </div>
  );
}
