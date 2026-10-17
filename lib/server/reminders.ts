import { LEVELS, READING_CADENCE_MIN } from "../levels";
import type { Reminder, Station } from "../schemas";
import { type Db, newId } from "./db";
import { formatTime, type Notifier, notifyTeam } from "./notify";
import { getStationStatus } from "./status";

export async function scheduleReminder(
  db: Db,
  stationId: string,
  minutesFromNow: number,
  reason: string,
  now = new Date(),
): Promise<Reminder> {
  const r: Reminder = {
    id: newId(),
    stationId,
    dueAt: new Date(now.getTime() + minutesFromNow * 60_000).toISOString(),
    reason,
    sentAt: null,
    createdAt: now.toISOString(),
  };
  await db.insertReminder(r);
  return r;
}

function reminderText(station: Station, reason: string): string {
  return (
    `📏 ${station.name}: pakikuha ng bagong sukat ng tubig at litrato ng gauge.\n` +
    `Please take a new gauge reading and photo.\nReason: ${reason}`
  );
}

/**
 * Send due reminders to each station's observer team:
 * 1. explicit reminders (e.g. scheduled by the alert agent), and
 * 2. routine cadence — at alert stage or above, readings are due every
 *    60/30/15 minutes; if the latest reading is older than that, nudge the team.
 */
export async function processReminders(db: Db, notifier: Notifier, now = new Date()) {
  const nowIso = now.toISOString();
  let explicit = 0;
  let cadence = 0;

  const stations = await db.listStations();
  const byId = new Map(stations.map((s) => [s.id, s]));

  for (const r of await db.listReminders({ dueBeforeIso: nowIso, unsentOnly: true })) {
    const station = byId.get(r.stationId);
    if (station) await notifyTeam(notifier, station, reminderText(station, r.reason));
    await db.markReminderSent(r.id, nowIso);
    explicit++;
  }

  for (const station of stations) {
    const status = await getStationStatus(db, station, now);
    if (!status.stage || !status.latest) continue;
    const every = READING_CADENCE_MIN[status.stage];
    if (!every) continue;
    const ageMin = (now.getTime() - Date.parse(status.latest.takenAt)) / 60_000;
    if (ageMin < every) continue;

    // Don't nag more often than the cadence itself.
    const recent = await db.listReminders({ stationId: station.id });
    const lastCadence = recent
      .filter((r) => r.reason.startsWith("cadence") && r.sentAt)
      .map((r) => Date.parse(r.sentAt!))
      .sort((a, b) => b - a)[0];
    if (lastCadence && now.getTime() - lastCadence < every * 60_000) continue;

    const reason = `cadence: river at ${LEVELS[status.stage].label}; last reading ${formatTime(status.latest.takenAt)} (${Math.round(ageMin)} min ago), readings due every ${every} min`;
    await notifyTeam(notifier, station, reminderText(station, reason));
    await db.insertReminder({ id: newId(), stationId: station.id, dueAt: nowIso, reason, sentAt: nowIso, createdAt: nowIso });
    cadence++;
  }

  return { explicit, cadence };
}
