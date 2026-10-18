import { timingSafeEqual } from "node:crypto";

const isProd = () => process.env.NODE_ENV === "production";

export function safeEqual(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Admin actions need the x-admin-token header.
 *
 * With no ADMIN_TOKEN set the app stays open for local development, but a
 * production build refuses every admin action rather than running wide open.
 */
export function isAdmin(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return !isProd();
  return safeEqual(req.headers.get("x-admin-token") ?? "", expected);
}

/** True when admin actions are unprotected (dev only) — the UI warns about this. */
export function adminOpen(): boolean {
  return !process.env.ADMIN_TOKEN && !isProd();
}

export function adminRequired() {
  return Response.json(
    {
      error: process.env.ADMIN_TOKEN
        ? "Admin token required."
        : "Admin actions are disabled: set ADMIN_TOKEN on the server.",
    },
    { status: 401 },
  );
}

export function badRequest(error: unknown) {
  const message =
    error && typeof error === "object" && "issues" in error
      ? (error as { issues: { path: PropertyKey[]; message: string }[] }).issues
          .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
          .join("; ")
      : String(error);
  return Response.json({ error: message }, { status: 400 });
}

export function tooManyRequests(retryAfterSec: number) {
  return Response.json(
    { error: `Too many requests from this device. Try again in ${retryAfterSec}s.` },
    { status: 429, headers: { "retry-after": String(retryAfterSec) } },
  );
}
