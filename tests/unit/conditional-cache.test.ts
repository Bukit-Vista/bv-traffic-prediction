import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyConditionalHeaders,
  cacheControlForAt,
  conditionalNotModified,
  createResourceEtag,
  requestMatchesEtag
} from "@/lib/api/conditional-cache";
import { conditionalFetchJson } from "@/lib/api/conditional-client";
import { apiError, apiJson } from "@/lib/api/response";

afterEach(() => vi.unstubAllGlobals());

describe("conditional dashboard caching", () => {
  it("creates stable scoped ETags and changes them with source or viewport identity", () => {
    const first = createResourceEtag("flow-map", { slot: "2026-07-17T00:00:00Z", run: 56 }, { bbox: [1, 2, 3, 4], confidence: 0 });
    const reordered = createResourceEtag("flow-map", { run: 56, slot: "2026-07-17T00:00:00Z" }, { confidence: 0, bbox: [1, 2, 3, 4] });
    expect(reordered).toBe(first);
    expect(createResourceEtag("flow-map", { run: 57, slot: "2026-07-17T00:30:00Z" }, { confidence: 0, bbox: [1, 2, 3, 4] })).not.toBe(first);
    expect(createResourceEtag("flow-map", { run: 56, slot: "2026-07-17T00:00:00Z" }, { confidence: 0, bbox: [2, 2, 3, 4] })).not.toBe(first);
  });

  it("matches weak or strong validators and returns a bodyless 304", () => {
    const etag = createResourceEtag("routes", { run: 101 });
    const request = new Request("http://localhost/api/v1/routes", { headers: { "If-None-Match": etag.replace("W/", "") } });
    expect(requestMatchesEtag(request, etag)).toBe(true);
    const response = conditionalNotModified(request, etag);
    expect(response?.status).toBe(304);
    expect(response?.headers.get("etag")).toBe(etag);
    expect(response?.headers.get("cache-control")).toContain("must-revalidate");
  });

  it("uses revalidation for latest data, longer historical caching, and no-store errors", () => {
    expect(cacheControlForAt("latest")).toContain("no-cache");
    expect(cacheControlForAt("2026-07-17T00:00:00Z")).toContain("max-age=3600");
    const success = applyConditionalHeaders(apiJson({ ok: true }), createResourceEtag("test", 1));
    expect(success.headers.get("etag")).toBeTruthy();
    expect(apiError(new Error("hidden")).headers.get("cache-control")).toBe("no-store");
  });

  it("sends If-None-Match and does not parse or replace data on 304", async () => {
    const etags = new Map([["/resource", "W/\"existing\""]]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 304, headers: { ETag: "W/\"existing\"" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await conditionalFetchJson("/resource", etags, new AbortController().signal);
    expect(result).toEqual({ modified: false });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ "If-None-Match": "W/\"existing\"" });
  });

  it("stores a new validator only after a successful modified response", async () => {
    const etags = new Map<string, string>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: 42 }), {
      status: 200, headers: { "Content-Type": "application/json", ETag: "W/\"new\"" }
    })));
    const result = await conditionalFetchJson<{ data: number }>("/resource", etags, new AbortController().signal);
    expect(result).toEqual({ modified: true, value: { data: 42 } });
    expect(etags.get("/resource")).toBe("W/\"new\"");
  });
});
