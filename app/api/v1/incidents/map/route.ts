import { apiError, apiGeoJson } from "@/lib/api/response";
import { getIncidentMap } from "@/lib/api/data-source";
import { mapQuerySchema, parseQuery } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(mapQuerySchema, request);
    const result = await getIncidentMap(input);
    return apiGeoJson(result.collection, { selectedSlot: result.selectedSlot, source: result.source });
  } catch (error) {
    return apiError(error);
  }
}

