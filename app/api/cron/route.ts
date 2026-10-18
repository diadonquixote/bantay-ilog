import { safeEqual, tooManyRequests } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { getNotifier } from "@/lib/server/notify";
import { clientKey, rateLimit } from "@/lib/server/rateLimit";
import { tick } from "@/lib/server/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Reminders, the PAGASA check and message retries, driven by whatever scheduler
 * the deployment has (Vercel cron, a container's crontab, UptimeRobot).
 *
 *   curl -X POST https://…/api/cron -H "x-cron-secret: …"
 *
 * Without CRON_SECRET the endpoint is disabled rather than public: an open one
 * would let anyone spend the station's model budget.
 */
function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
  if (header && safeEqual(header, expected)) return true;
  const q = new URL(req.url).searchParams.get("secret");
  return !!q && safeEqual(q, expected);
}

async function run(req: Request) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "Scheduled runs are disabled: set CRON_SECRET on the server." }, { status: 404 });
  }
  if (!authorized(req)) return Response.json({ error: "Bad cron secret." }, { status: 401 });
  const wait = rateLimit(`cron:${clientKey(req)}`, { limit: 10, windowSec: 60 });
  if (wait != null) return tooManyRequests(wait);

  const db = getDb();
  const result = await tick(db, getNotifier(db), { log: (m) => console.log(`[cron] ${m}`) });
  return Response.json({ ok: true, ...result });
}

export const POST = run;
export const GET = run;
