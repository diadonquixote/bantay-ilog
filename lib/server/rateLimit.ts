/**
 * Small in-process token bucket. Enough to stop one phone (or one script) from
 * flooding the photo endpoint, which costs a model call per request. Behind
 * several server instances each one keeps its own count; put a real limiter in
 * front of the app for a large deployment.
 */
interface Bucket {
  tokens: number;
  updated: number;
}

const g = globalThis as unknown as { __bantayBuckets?: Map<string, Bucket> };
const buckets = (): Map<string, Bucket> => (g.__bantayBuckets ??= new Map());

const MAX_KEYS = 5_000;

/** Best-effort caller identity: the first hop in x-forwarded-for, else a shared bucket. */
export function clientKey(req: Request): string {
  const h = req.headers;
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || h.get("x-real-ip") || h.get("cf-connecting-ip") || "unknown";
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  windowSec: number;
}

/** Returns null when the call is allowed, or the seconds to wait before retrying. */
export function rateLimit(key: string, opts: RateLimitOptions, now = Date.now()): number | null {
  const map = buckets();
  if (map.size > MAX_KEYS) map.clear();
  const perSec = opts.limit / opts.windowSec;
  const b = map.get(key) ?? { tokens: opts.limit, updated: now };
  b.tokens = Math.min(opts.limit, b.tokens + ((now - b.updated) / 1000) * perSec);
  b.updated = now;
  if (b.tokens < 1) {
    map.set(key, b);
    return Math.max(1, Math.ceil((1 - b.tokens) / perSec));
  }
  b.tokens -= 1;
  map.set(key, b);
  return null;
}

/** Test helper. */
export function resetRateLimits() {
  buckets().clear();
}
