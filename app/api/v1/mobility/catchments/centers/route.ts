import {
  publicCatchmentError,
  publicCatchmentJson,
  requirePublicCatchmentRequest
} from "@/lib/api/public-catchment-route";
import { readCatchmentCenters } from "@/lib/api/internal-catchment-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = requirePublicCatchmentRequest(request);
  if (access.response) return access.response;
  try {
    const category = new URL(request.url).searchParams.get("category");
    const result = await readCatchmentCenters(category, undefined, "public");
    return publicCatchmentJson(request, result.meta, {
      category: result.category,
      summaries: result.summaries
    }, { category: result.category });
  } catch (error) {
    return publicCatchmentError(error);
  }
}
