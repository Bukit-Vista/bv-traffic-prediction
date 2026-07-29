import Link from "next/link";
import { notFound } from "next/navigation";
import { RouteDetailCharts } from "@/components/charts/RouteDetailCharts";
import { formatCongestionScore } from "@/lib/analytics/congestion";
import { formatDuration } from "@/lib/analytics/duration";
import { calculateCongestionScore } from "@/lib/analytics/congestion";
import { getRouteDetail } from "@/lib/data/route-detail";

export const dynamic = "force-dynamic";

type RoutePageProps = {
  params: Promise<{ slug: string }>;
};

export default async function RoutePage({ params }: RoutePageProps) {
  const { slug } = await params;
  const detail = await getRouteDetail(slug);

  if (!detail) {
    notFound();
  }

  const latestScore = detail.latest ? calculateCongestionScore(detail.latest) : null;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <Link href="/" className="text-sm text-muted hover:text-ink">
        Back to dashboard
      </Link>

      <div className="mt-4 flex flex-col gap-4 border-b border-line pb-6 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-muted">
            {detail.route.category}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-normal">
            {detail.route.originLabel} to {detail.route.destinationLabel}
          </h1>
        </div>
        <span className="w-fit rounded bg-white px-3 py-1 text-sm font-medium">
          {detail.route.active ? "Active" : "Inactive"}
        </span>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-4">
        <Metric label="Current" value={formatDuration(detail.latest?.trafficDurationSeconds)} />
        <Metric label="Normal" value={formatDuration(detail.latest?.durationSeconds)} />
        <Metric label="Score" value={formatCongestionScore(latestScore)} />
        <Metric
          label="Distance"
          value={
            detail.latest
              ? `${(detail.latest.distanceMeters / 1000).toFixed(1)} km`
              : "Missing"
          }
        />
      </div>

      <div className="mt-8">
        <RouteDetailCharts
          today={detail.today}
          history={detail.history}
          hourlyAverage={detail.hourlyAverage}
          retentionDays={detail.retentionDays}
        />
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}
