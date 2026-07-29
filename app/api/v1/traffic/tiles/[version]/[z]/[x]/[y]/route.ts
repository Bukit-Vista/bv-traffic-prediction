import { readTrafficVectorTile } from "@/lib/snapshot/traffic-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ version: string; z: string; x: string; y: string }> }) {
  const { version, z, x, y } = await context.params;
  const startedAt = performance.now();
  const tile = await readTrafficVectorTile(version, Number(z), Number(x), Number(y));
  const serverTiming = `redis;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`;
  if (!tile) {
    return new Response(null, {
      // MapLibre treats a missing vector tile as empty only when the source
      // returns 404. A 204 response is passed to the PBF decoder as zero bytes.
      status: 404,
      headers: {
        // A missing row is normally an empty tile, but can also indicate a
        // transient Redis read failure. Never poison browser caches.
        "Cache-Control": "no-store",
        "Server-Timing": serverTiming,
        "X-Traffic-Snapshot": version
      }
    });
  }
  return new Response(new Uint8Array(tile), {
    headers: {
      "Content-Type": "application/vnd.mapbox-vector-tile",
      "Content-Encoding": "gzip",
      "Content-Length": String(tile.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Server-Timing": serverTiming,
      "X-Traffic-Snapshot": version
    }
  });
}
