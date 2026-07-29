import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCachedJson, fetchCachedJson } from "@/lib/ui/client-data-cache";

const TEST_URL = "/api/test/preloaded-dashboard-data";

afterEach(() => {
  clearCachedJson(TEST_URL);
  vi.unstubAllGlobals();
});

describe("client data preload cache", () => {
  it("shares one in-flight request and reuses the resolved response", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: { ready: true } }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      fetchCachedJson<{ data: { ready: boolean } }>(TEST_URL),
      fetchCachedJson<{ data: { ready: boolean } }>(TEST_URL)
    ]);
    const third = await fetchCachedJson<{ data: { ready: boolean } }>(TEST_URL);

    expect(first).toEqual({ data: { ready: true } });
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
