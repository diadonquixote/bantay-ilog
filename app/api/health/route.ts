import { aiMode } from "@/lib/server/ai";
import { getDb } from "@/lib/server/db";
import { getStationStatus, isStale, STALE_AFTER_MIN } from "@/lib/server/status";
import { LAST_TICK_KEY } from "@/lib/server/tick";

export const dynamic = "force-dynamic";

/** A monitor can watch this: it goes unhealthy when the background job stops or a station goes quiet. */
export async function GET() {
  const db = getDb();
  const stations = await db.listStations();
  const lastTick = await db.getMeta(LAST_TICK_KEY);
  const tickAgeMin = lastTick ? Math.round((Date.now() - Date.parse(lastTick)) / 60_000) : null;

  const rows = await Promise.all(
    stations
      .filter((s) => s.id !== "demo")
      .map(async (s) => {
        const st = await getStationStatus(db, s);
        return {
          id: s.id,
          stage: st.stage,
          ageMinutes: st.ageMinutes,
          stale: isStale(st),
          pendingConfirmations: st.pendingConfirmations,
          hasTeam: s.teamChatIds.length > 0,
        };
      }),
  );

  // Only alarming when a schedule is configured at all.
  const tickLate = process.env.CRON_SECRET || process.env.PAGASA_ADVISORY_URL ? (tickAgeMin ?? 999) > 20 : false;
  const elevatedAndStale = rows.some((r) => r.stale && r.stage && r.stage !== "normal");
  const ok = !tickLate && !elevatedAndStale;

  return Response.json(
    {
      ok,
      db: db.kind,
      ai: aiMode(),
      telegram: process.env.TELEGRAM_BOT_TOKEN ? "live" : "log",
      lastTick,
      tickAgeMinutes: tickAgeMin,
      staleAfterMinutes: STALE_AFTER_MIN,
      stations: rows,
    },
    { status: ok ? 200 : 503 },
  );
}
