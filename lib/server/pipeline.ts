import { classify, formatLevel, LEVELS } from "../levels";
import type { Reading, ReadingSource, Station } from "../schemas";
import { agree } from "./agree";
import { type AgentOutcome, runAlertAgent } from "./alertAgent";
import { type Db, newId, nowIso } from "./db";
import { type Button, dashboardUrl, formatTime, type Notifier, notifyTeam } from "./notify";
import type { GaugeRead } from "./readGauge";

export interface IngestInput {
  station: Station;
  source: ReadingSource;
  ai: GaugeRead | null;
  observerLevel: number | null;
  observerName: string | null;
  takenAt?: string;
  clientId?: string | null;
  photoPath?: string | null;
}

export interface IngestResult {
  reading: Reading;
  duplicate: boolean;
  /** Present when the reading was accepted and the alert step ran synchronously. */
  outcome: AgentOutcome | null;
  /** For readings that need confirmation: how many team chats were asked (0 = nobody set up). */
  teamNotified: number | null;
}

export async function ingestReading(
  db: Db,
  notifier: Notifier,
  input: IngestInput,
  opts: { runAgent?: boolean } = { runAgent: true },
): Promise<IngestResult> {
  const { station } = input;
  if (input.clientId) {
    const existing = await db.findReadingByClientId(station.id, input.clientId);
    if (existing) return { reading: existing, duplicate: true, outcome: null, teamNotified: null };
  }

  const takenAt = input.takenAt ?? nowIso();
  const [previous] = await db.listReadings(station.id, { status: "accepted", limit: 1 });
  const decision = agree(
    {
      aiLevel: input.ai?.level ?? null,
      aiConfidence: input.ai?.confidence ?? null,
      observerLevel: input.observerLevel,
      previous: previous?.level != null ? { level: previous.level, takenAt: previous.takenAt } : null,
      takenAt,
    },
    station,
  );

  const reading = await db.insertReading({
    id: newId(),
    stationId: station.id,
    clientId: input.clientId ?? null,
    takenAt,
    createdAt: nowIso(),
    source: input.source,
    aiLevel: input.ai?.level ?? null,
    aiConfidence: input.ai?.confidence ?? null,
    aiNotes: input.ai?.notes ?? null,
    observerLevel: input.observerLevel,
    observerName: input.observerName,
    level: decision.level,
    status: decision.status,
    statusReason: decision.reason,
    photoPath: input.photoPath ?? null,
    confirmedBy: null,
  });

  if (reading.status === "needs_confirmation") {
    const teamNotified = await requestConfirmation(notifier, station, reading, decision.urgent);
    if (teamNotified === 0) {
      console.warn(`[pipeline] ${station.id}: reading ${reading.id} needs confirmation but the station has no observer team`);
    }
    return { reading, duplicate: false, outcome: null, teamNotified };
  }
  if (reading.status === "accepted" && opts.runAgent !== false) {
    return { reading, duplicate: false, outcome: await afterAccepted(db, notifier, station, reading), teamNotified: null };
  }
  return { reading, duplicate: false, outcome: null, teamNotified: null };
}

export async function afterAccepted(db: Db, notifier: Notifier, station: Station, reading: Reading) {
  return runAlertAgent({ db, notifier, station, readingId: reading.id, now: new Date(), sent: [] });
}

async function requestConfirmation(notifier: Notifier, station: Station, r: Reading, urgent: boolean): Promise<number> {
  const top = Math.max(r.aiLevel ?? -Infinity, r.observerLevel ?? -Infinity);
  const stage = Number.isFinite(top) ? classify(top, station.thresholds) : "normal";
  const lines = [
    `${urgent ? "🚨 URGENT — " : stage !== "normal" ? "⚠️ " : ""}Pakikumpirma / Please confirm a reading`,
    `${station.name}, ${formatTime(r.takenAt)}`,
    `AI: ${formatLevel(r.aiLevel)}${r.aiConfidence != null ? ` (confidence ${r.aiConfidence.toFixed(2)})` : ""}`,
    `Observer${r.observerName ? ` (${r.observerName})` : ""}: ${formatLevel(r.observerLevel)}`,
    `Why: ${r.statusReason}`,
  ];
  if (stage !== "normal") lines.push(`If confirmed this is ${LEVELS[stage].label}; residents are alerted only after confirmation.`);
  const url = dashboardUrl(station.id);
  if (url) lines.push(url);

  const buttons: Button[][] = [];
  const row: Button[] = [];
  if (r.aiLevel != null) row.push({ text: `✔ ${r.aiLevel.toFixed(2)} m (AI)`, data: `c:${r.id}:${r.aiLevel}` });
  if (r.observerLevel != null && r.observerLevel !== r.aiLevel) {
    row.push({ text: `✔ ${r.observerLevel.toFixed(2)} m (observer)`, data: `c:${r.id}:${r.observerLevel}` });
  }
  if (row.length) buttons.push(row);
  buttons.push([{ text: "✖ Reject", data: `x:${r.id}` }]);

  return notifyTeam(notifier, station, lines.join("\n"), buttons);
}

export class ConfirmError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function confirmReading(
  db: Db,
  notifier: Notifier,
  args: { readingId: string; action: "accept" | "reject"; level?: number; confirmedBy: string },
): Promise<{ reading: Reading; outcome: AgentOutcome | null }> {
  const reading = await db.getReading(args.readingId);
  if (!reading) throw new ConfirmError("Reading not found.", 404);
  if (reading.status !== "needs_confirmation") {
    throw new ConfirmError(`Reading is already ${reading.status.replace("_", " ")}.`, 409);
  }
  if (reading.observerName && reading.observerName === args.confirmedBy) {
    throw new ConfirmError("A reading must be confirmed by someone other than the observer who sent it.", 403);
  }
  const station = await db.getStation(reading.stationId);
  if (!station) throw new ConfirmError("Station not found.", 404);

  if (args.action === "reject") {
    const updated = await db.updateReading(reading.id, {
      status: "rejected",
      statusReason: `Rejected by ${args.confirmedBy}. ${reading.statusReason}`,
      confirmedBy: args.confirmedBy,
    });
    return { reading: updated!, outcome: null };
  }

  const level = args.level;
  if (level == null || !Number.isFinite(level)) throw new ConfirmError("A level is required to accept.", 400);
  if (level < station.gaugeMin - 0.5 || level > station.gaugeMax + 0.5) {
    throw new ConfirmError(`Level ${level} m is outside the gauge range.`, 400);
  }
  const updated = await db.updateReading(reading.id, {
    status: "accepted",
    level: Math.round(level * 100) / 100,
    statusReason: `Confirmed by ${args.confirmedBy} (${reading.statusReason})`,
    confirmedBy: args.confirmedBy,
  });
  const outcome = await afterAccepted(db, notifier, station, updated!);
  return { reading: updated!, outcome };
}
