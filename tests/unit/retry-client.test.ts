import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJsonWithTimeoutRetry } from "@/lib/api/retry-client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("five-second client recovery requests", () => {
  it("aborts a stalled attempt and immediately requests the data again", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: "FeatureCollection", features: [1] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));

    const result = await fetchJsonWithTimeoutRetry<{ features: number[] }>("/geometry?at=slot", {
      signal: new AbortController().signal,
      timeoutMs: 10,
      maxAttempts: 2
    });

    expect(result.features).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/geometry?at=slot&_requestAttempt=2");
  });

  it("retries a transient server error without waiting for the timeout", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(fetchJsonWithTimeoutRetry<{ ok: boolean }>("/geometry", {
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      maxAttempts: 2
    })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
