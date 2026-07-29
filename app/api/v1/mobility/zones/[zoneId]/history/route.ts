import { apiError, FeatureNotReadyError } from "@/lib/api/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return apiError(new FeatureNotReadyError("mobility_prediction_history", "Prediction history remains unavailable until a production history read contract is approved."));
}
