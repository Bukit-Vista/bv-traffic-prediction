import { apiError, apiJson } from "@/lib/api/response";
import { parseQuery, rangeQuerySchema } from "@/lib/api/validation";
import { fixtureForSlot } from "@/lib/api/demo-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(rangeQuerySchema, request);
    const url = new URL(request.url);
    const category = url.searchParams.get("category");
    const severity = url.searchParams.get("severity");
    const fixture = fixtureForSlot("latest");
    const incidents = fixture.incidents.features.filter((feature) => (!category || feature.properties.category === category) && (!severity || feature.properties.severity === severity));
    return apiJson({ incidents, count: incidents.length, bucket: input.bucket ?? "1h" }, { selectedSlot: fixture.selectedSlot, source: "demo_fixture" });
  } catch (error) { return apiError(error); }
}
