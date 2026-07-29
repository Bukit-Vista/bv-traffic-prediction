import { apiError, apiJson } from "@/lib/api/response";
import { readDisplayGrid } from "@/lib/api/display-grid";
import { displayGridQuerySchema, parseQuery } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(displayGridQuerySchema, request);
    const result = await readDisplayGrid(input);
    const response = apiJson(result.data, result.meta);
    response.headers.set("Cache-Control", "private, no-cache, must-revalidate");
    return response;
  } catch (error) {
    return apiError(error);
  }
}
