import {
  internalCatchmentError,
  internalCatchmentJson,
  requireInternalCatchmentRequest
} from "@/lib/api/internal-catchment-route";
import { readCatchmentZones } from "@/lib/api/internal-catchment-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = requireInternalCatchmentRequest(request);
  if (access.response) return access.response;
  try {
    const result = await readCatchmentZones();
    return internalCatchmentJson(request, result.meta, result.collection);
  } catch (error) {
    return internalCatchmentError(error);
  }
}
