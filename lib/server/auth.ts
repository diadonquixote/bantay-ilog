import { timingSafeEqual } from "node:crypto";

/** Admin actions are open when ADMIN_TOKEN is unset (local/dev); otherwise the x-admin-token header must match. */
export function isAdmin(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return true;
  const got = req.headers.get("x-admin-token") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function adminRequired() {
  return Response.json({ error: "Admin token required." }, { status: 401 });
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
