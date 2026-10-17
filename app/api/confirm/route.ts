import { ConfirmRequest } from "@/lib/schemas";
import { adminRequired, badRequest, isAdmin } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { getNotifier } from "@/lib/server/notify";
import { ConfirmError, confirmReading } from "@/lib/server/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Accept (with a level) or reject a reading that needs confirmation. */
export async function POST(req: Request) {
  if (!isAdmin(req)) return adminRequired();
  const parsed = ConfirmRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  const db = getDb();
  try {
    const body = parsed.data;
    const result = await confirmReading(db, getNotifier(db), {
      readingId: body.readingId,
      action: body.action,
      level: body.action === "accept" ? body.level : undefined,
      confirmedBy: body.confirmedBy,
    });
    return Response.json(result);
  } catch (e) {
    if (e instanceof ConfirmError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
