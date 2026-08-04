import { withBasePath } from "@/lib/urls/base-path";

export type ConditionalResult<T> = { modified: false } | { modified: true; value: T };

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function conditionalFetchJson<T>(
  url: string,
  etags: Map<string, string>,
  signal: AbortSignal
): Promise<ConditionalResult<T>> {
  const previousEtag = etags.get(url);
  const response = await fetch(withBasePath(url), {
    signal,
    cache: "no-cache",
    headers: previousEtag ? { "If-None-Match": previousEtag } : undefined
  });
  if (response.status === 304) return { modified: false };
  const value = await responseJson<T>(response);
  const etag = response.headers.get("etag");
  if (etag) etags.set(url, etag);
  return { modified: true, value };
}
