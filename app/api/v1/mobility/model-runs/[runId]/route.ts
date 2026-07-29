import { apiError, FeatureNotReadyError } from "@/lib/api/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return apiError(new FeatureNotReadyError("mobility_model_run_detail", "Model-run detail remains unavailable until a production operations read contract is approved."));
}
