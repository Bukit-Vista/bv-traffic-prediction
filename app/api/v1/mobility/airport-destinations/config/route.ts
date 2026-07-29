import { apiError, apiJson } from "@/lib/api/response";
import { getAirportDestinations } from "@/lib/api/database-serving-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const destinations = await getAirportDestinations();
    const first = destinations[0] ?? null;
    return apiJson({
      destinations,
      count: destinations.length,
      scope: first ? {
        scopeKey: first.scopeKey,
        scopeVersion: first.scopeVersion,
        scopeStatus: first.scopeStatus,
        predictionEnabled: first.predictionEnabled
      } : null
    }, {
      source: "api_airport_destinations_v1",
      status: "fresh",
      stale: false,
      semantics: null,
      disclaimer: "This endpoint exposes the fixed candidate registry only. It does not return predictions or people counts."
    });
  } catch (error) {
    return apiError(error);
  }
}
