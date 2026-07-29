import { apiError, apiJson } from "@/lib/api/response";
import { validateFullSourceContract } from "@/lib/api/source-contract";
import { requireOperationsRole } from "@/lib/api/access-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireOperationsRole(request);
    const checks = await validateFullSourceContract();
    return apiJson({ ready: true, checks }, { source: "mysql_schema_contract", status: "success" });
  } catch (error) {
    return apiError(error);
  }
}
