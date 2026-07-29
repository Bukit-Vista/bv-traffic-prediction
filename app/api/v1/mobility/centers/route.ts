import { apiError, apiJson } from "@/lib/api/response";
import { readHerePlaces } from "@/lib/api/here-places";
import { parseQuery, placesQuerySchema } from "@/lib/api/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(placesQuerySchema, request);
    const result = await readHerePlaces(input);
    const response = apiJson(result.data, result.meta);
    const etagSeed = [
      result.meta.importVersion, input.mode, input.bbox?.join(",") ?? "all",
      input.zoom ?? "", input.category ?? "all", input.eligibleOnly, input.limit, input.cursor ?? ""
    ].join("|");
    const etag = `"places-${Buffer.from(etagSeed).toString("base64url").slice(0, 48)}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, max-age=86400, stale-while-revalidate=2592000" } });
    }
    response.headers.set("ETag", etag);
    response.headers.set("Cache-Control", "private, max-age=86400, stale-while-revalidate=2592000");
    return response;
  } catch (error) {
    return apiError(error);
  }
}
