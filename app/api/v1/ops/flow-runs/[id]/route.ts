import { apiError, apiJson } from "@/lib/api/response";
import { getRuns } from "@/lib/api/data-source";
import { idSchema } from "@/lib/api/validation";
import { requireOperationsRole } from "@/lib/api/access-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireOperationsRole(request);
    const id = idSchema.parse((await context.params).id);
    const run = (await getRuns("flow")).find((candidate) => candidate.id === id);
    if (!run) return apiJson(null, { status: "unavailable" }, { status: 404 });
    return apiJson({ run, rawResponseAccess: "not_exposed" }, { selectedSlot: run.slotUtc });
  } catch (error) { return apiError(error); }
}
