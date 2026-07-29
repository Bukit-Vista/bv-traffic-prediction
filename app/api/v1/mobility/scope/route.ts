import { apiError, apiJson } from "@/lib/api/response";
import { getMobilityProductScope } from "@/lib/api/database-serving-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scope = await getMobilityProductScope();
    return apiJson(scope, {
      source: "api_mobility_scope_v1",
      status: "fresh",
      stale: false,
      semantics: null,
      disclaimer: scope.disclaimer
    });
  } catch (error) {
    return apiError(error);
  }
}
