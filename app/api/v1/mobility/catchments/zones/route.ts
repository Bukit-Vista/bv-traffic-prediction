import {
  publicCatchmentError,
  publicCatchmentJson,
  requirePublicCatchmentRequest
} from "@/lib/api/public-catchment-route";
import { readCatchmentZones } from "@/lib/api/internal-catchment-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = requirePublicCatchmentRequest(request);
  if (access.response) return access.response;
  try {
    const result = await readCatchmentZones(undefined, "public");
    return publicCatchmentJson(request, result.meta, result.collection);
  } catch (error) {
    return publicCatchmentError(error);
  }
}
