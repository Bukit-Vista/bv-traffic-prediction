import { fetchJsonWithTimeoutRetry } from "@/lib/api/retry-client";

type CacheEntry = {
  expiresAt: number;
  promise: Promise<unknown>;
};

type CachedJsonOptions = {
  ttlMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
};

const responseCache = new globalThis.Map<string, CacheEntry>();

export function fetchCachedJson<T>(
  url: string,
  options: CachedJsonOptions = {}
): Promise<T> {
  const now = Date.now();
  const cached = responseCache.get(url);
  if (cached && cached.expiresAt > now) return cached.promise as Promise<T>;
  if (cached) responseCache.delete(url);

  const controller = new AbortController();
  const promise = fetchJsonWithTimeoutRetry<T>(url, {
    signal: controller.signal,
    timeoutMs: options.timeoutMs ?? 15_000,
    maxAttempts: options.maxAttempts ?? 2
  }).catch((error) => {
    responseCache.delete(url);
    throw error;
  });
  responseCache.set(url, {
    expiresAt: now + (options.ttlMs ?? 5 * 60_000),
    promise
  });
  return promise;
}

export function clearCachedJson(url: string) {
  responseCache.delete(url);
}
