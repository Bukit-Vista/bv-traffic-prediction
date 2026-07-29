import { apiError, FeatureNotReadyError } from "@/lib/api/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return apiError(new FeatureNotReadyError("unsupported_analytics"));
}
