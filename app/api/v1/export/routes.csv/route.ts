import { apiError } from "@/lib/api/response";
import { getRoutes } from "@/lib/api/data-source";

function csvCell(value: unknown) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const routeId = Number(new URL(request.url).searchParams.get("routeId"));
    const routes = (await getRoutes()).filter((route) => !Number.isFinite(routeId) || route.id === routeId);
    const header = ["route_id","route","category","route_purpose","route_group_key","tourism_center_key","route_direction","collection_slot_utc","sampled_at_utc","distance_meters","current_duration_seconds","typical_duration_seconds","base_duration_seconds","delay_vs_typical_seconds","delay_vs_base_seconds","ratio_vs_typical","ratio_vs_base","geometry_available"];
    const lines = routes.map((r) => [r.id,r.name,r.category,r.routePurpose,r.routeGroupKey,r.tourismCenterKey,r.routeDirection,r.collectionSlotUtc,r.sampledAtUtc,r.distanceMeters,r.currentDurationSeconds,r.typicalDurationSeconds,r.baseDurationSeconds,r.delayVsTypicalSeconds,r.delayVsBaseSeconds,r.ratioVsTypical,r.ratioVsBase,r.geometryAvailable].map(csvCell).join(","));
    return new Response([header.join(","), ...lines].join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=bali-routes.csv" } });
  } catch (error) { return apiError(error); }
}
