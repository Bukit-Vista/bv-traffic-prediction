import { timingSafeEqual } from "node:crypto";
import { ApiAuthorizationError, ApiRateLimitError, ApiUnavailableError } from "@/lib/api/core";

type AccessEnv = {
  [key: string]: string | undefined;
  OPERATIONS_API_TOKEN?: string;
  API_RATE_LIMIT_ENABLED?: string;
};

type RateEntry = { count: number; resetAt: number };
const rateEntries = new Map<string, RateEntry>();

function safeTokenMatch(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function requireOperationsRole(request: Request, env: AccessEnv = process.env) {
  const expected = env.OPERATIONS_API_TOKEN?.trim();
  if (!expected) throw new ApiUnavailableError("Operations authorization is not configured.");
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!supplied) throw new ApiAuthorizationError(401, "Operations credentials are required.");
  if (!safeTokenMatch(supplied, expected)) throw new ApiAuthorizationError(403, "The supplied role cannot access operations history.");
}

function clientAddress(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() || "local";
}

export function enforceRateLimit(
  request: Request,
  resource: string,
  options: { maximum?: number; windowMs?: number; now?: number; env?: AccessEnv } = {}
) {
  const env = options.env ?? process.env;
  if (env.API_RATE_LIMIT_ENABLED === "false") return;
  const maximum = options.maximum ?? 90;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now();
  const key = `${resource}|${clientAddress(request)}`;
  const existing = rateEntries.get(key);
  const entry = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + windowMs } : existing;
  entry.count += 1;
  rateEntries.set(key, entry);
  if (rateEntries.size > 2_000) {
    for (const [candidate, value] of rateEntries) if (value.resetAt <= now) rateEntries.delete(candidate);
  }
  if (entry.count > maximum) {
    throw new ApiRateLimitError(Math.max(1, Math.ceil((entry.resetAt - now) / 1_000)));
  }
}

export function clearRateLimitsForTests() {
  rateEntries.clear();
}
