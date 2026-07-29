type RetryJsonOptions = {
  signal: AbortSignal;
  timeoutMs?: number;
  maxAttempts?: number;
};

class HttpResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HttpResponseError";
  }
}

function requestUrl(url: string, attempt: number) {
  if (attempt === 1) return url;
  return `${url}${url.includes("?") ? "&" : "?"}_requestAttempt=${attempt}`;
}

function retryable(error: unknown, timedOut: boolean) {
  if (timedOut) return true;
  if (error instanceof HttpResponseError) return error.status >= 500;
  return error instanceof TypeError;
}

export async function fetchJsonWithTimeoutRetry<T>(url: string, options: RetryJsonOptions): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Retry request options are invalid.");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal.aborted) throw options.signal.reason ?? new DOMException("Request aborted", "AbortError");
    const attemptController = new AbortController();
    let timedOut = false;
    const abortAttempt = () => attemptController.abort(options.signal.reason);
    options.signal.addEventListener("abort", abortAttempt, { once: true });
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      attemptController.abort(new DOMException(`Request exceeded ${timeoutMs}ms`, "TimeoutError"));
    }, timeoutMs);

    try {
      const response = await fetch(requestUrl(url, attempt), {
        signal: attemptController.signal,
        cache: "no-cache"
      });
      const body = await response.json().catch(() => null) as T | { error?: { message?: string } } | null;
      if (!response.ok) {
        const message = body && typeof body === "object" && "error" in body
          ? body.error?.message ?? `Request failed with ${response.status}`
          : `Request failed with ${response.status}`;
        throw new HttpResponseError(message, response.status);
      }
      return body as T;
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason ?? error;
      lastError = timedOut
        ? new Error(`The request did not return data within ${Math.round(timeoutMs / 1_000)} seconds.`)
        : error;
      if (attempt === maxAttempts || !retryable(error, timedOut)) throw lastError;
    } finally {
      globalThis.clearTimeout(timer);
      options.signal.removeEventListener("abort", abortAttempt);
    }
  }
  throw lastError;
}
