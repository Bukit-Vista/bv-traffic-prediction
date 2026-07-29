import {
  internalCatchmentError,
  internalCatchmentJson,
  requireInternalCatchmentRequest
} from "@/lib/api/internal-catchment-route";
import { readCatchmentCenters } from "@/lib/api/internal-catchment-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = requireInternalCatchmentRequest(request);
  if (access.response) return access.response;
  try {
    const category = new URL(request.url).searchParams.get("category");
    const result = await readCatchmentCenters(category);
    return internalCatchmentJson(request, result.meta, {
      category: result.category,
      summaries: result.summaries
    }, { category: result.category });
  } catch (error) {
    return internalCatchmentError(error);
  }
}
