/**
 * One pass of everything that has to happen on a clock rather than on a photo:
 * the PAGASA advisory, reading reminders, retries for undelivered messages and
 * photo retention. Driven either by `npm run job:pagasa` or by POSTing to
 * /api/cron, so a deployment without a second process still keeps time.
 */
import { runAlertAgent } from "./alertAgent";
import type { Db } from "./db";
import { deliverPending, notifyTeam, type Notifier } from "./notify";
import { fetchAdvisory, recordAdvisory } from "./pagasa";
import { processReminders } from "./reminders";
import type { RainfallWarning } from "../schemas";

export const LAST_TICK_KEY = "last_tick";

/** Photos are personal data about a neighbourhood; keep them only as long as they are useful. */
export const photoRetentionDays = () => Number(process.env.PHOTO_RETENTION_DAYS || 30);

export interface TickResult {
  advisory: { warning: RainfallWarning; escalated: boolean } | null;
  reminders: { explicit: number; cadence: number };
  outbox: { sent: number; failed: number };
  photosPurged: number;
  notes: string[];
}

export async function tick(
  db: Db,
  notifier: Notifier,
  opts: { override?: { warning: RainfallWarning; text: string }; now?: Date; log?: (m: string) => void } = {},
): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const notes: string[] = [];
  const log = opts.log ?? (() => {});
  const note = (m: string) => {
    notes.push(m);
    log(m);
  };

  const url = process.env.PAGASA_ADVISORY_URL;
  let fetched = opts.override ?? null;
  if (!fetched && url) {
    try {
      fetched = await fetchAdvisory(url);
    } catch (e) {
      note(`advisory fetch failed: ${(e as Error).message}`);
    }
  } else if (!fetched) {
    note("PAGASA_ADVISORY_URL not set; skipping advisory fetch");
  }

  let advisoryResult: TickResult["advisory"] = null;
  if (fetched) {
    const { advisory, previous, escalated } = await recordAdvisory(db, fetched, opts.override ? "manual" : url!);
    advisoryResult = { warning: advisory.warning, escalated };
    note(`advisory: ${advisory.warning} (was ${previous?.warning ?? "none on record"})`);
    if (escalated && (advisory.warning === "orange" || advisory.warning === "red")) {
      for (const station of await db.listStations()) {
        if (station.id === "demo") continue;
        await notifyTeam(
          notifier,
          station,
          `🌧 PAGASA ${advisory.warning.toUpperCase()} rainfall warning. Dalasan ang pagkuha ng sukat sa ${station.name}.\n` +
            `Take gauge readings more often at ${station.name}.`,
        );
        const outcome = await runAlertAgent({ db, notifier, station, readingId: null, now, sent: [] });
        note(`${station.id}: alert agent ${outcome.mode} — ${outcome.summary}`);
      }
    }
  }

  const reminders = await processReminders(db, notifier, now);
  note(`reminders sent: ${reminders.explicit} scheduled, ${reminders.cadence} cadence`);

  const outbox = await deliverPending(db, notifier);
  if (outbox.sent || outbox.failed) note(`outbox retries: ${outbox.sent} delivered, ${outbox.failed} still failing`);

  const days = photoRetentionDays();
  let photosPurged = 0;
  if (days > 0) {
    photosPurged = await db.purgePhotos(new Date(now.getTime() - days * 86_400_000).toISOString());
    if (photosPurged) note(`deleted ${photosPurged} photo(s) older than ${days} days`);
  }
  await db.purgeReminders(new Date(now.getTime() - 14 * 86_400_000).toISOString());

  await db.setMeta(LAST_TICK_KEY, now.toISOString());
  return { advisory: advisoryResult, reminders, outbox, photosPurged, notes };
}
