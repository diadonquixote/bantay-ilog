import { createHash } from "node:crypto";
import { classify, formatLevel, LEVELS, rankOf } from "../levels";
import type { Alert, LevelKey, Reading, ReadingSource, Station } from "../schemas";
import { agree } from "./agree";
import { type AgentOutcome, runAlertAgent } from "./alertAgent";
import { type Db, newId, nowIso } from "./db";
import { type Button, dashboardUrl, formatTime, type Notifier, notifyTeam } from "./notify";
import type { GaugeRead } from "./readGauge";
import { getStationStatus } from "./status";
import { sendAlertChecked, ToolError } from "./tools";

export interface IngestInput {
  station: Station;
  source: ReadingSource;
  ai: GaugeRead | null;
  observerLevel: number | null;
  observerName: string | null;
  /** Stable identity of the sender, used for the two-person rule. */
  observerKey?: string | null;
  takenAt?: string;
  clientId?: string | null;
  photoPath?: string | null;
  photoBytes?: Buffer | null;
}

export interface IngestResult {
  reading: Reading;
  duplicate: boolean;
  /** Present when the reading was accepted and the alert step ran synchronously. */
  outcome: AgentOutcome | null;
  /** For readings that need confirmation: how many team chats were asked (0 = nobody set up). */
  teamNotified: number | null;
  /** Hedged warnings sent to residents while an elevated reading waits for a human. */
  provisional: Alert[];
}

export const photoHashOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** A person's stable identity for the two-person rule; names are compared case-insensitively. */
export const identityKey = (name: string | null | undefined): string | null => {
  const n = (name ?? "").trim();
  if (!n) return null;
  return n.toLowerCase().startsWith("tg:") ? n.toLowerCase() : `name:${n.toLowerCase().replace(/\s+/g, " ")}`;
};

export async function ingestReading(
  db: Db,
  notifier: Notifier,
  input: IngestInput,
  opts: { runAgent?: boolean } = { runAgent: true },
): Promise<IngestResult> {
  const { station } = input;
  if (input.clientId) {
    const existing = await db.findReadingByClientId(station.id, input.clientId);
    if (existing) return { reading: existing, duplicate: true, outcome: null, teamNotified: null, provisional: [] };
  }

  const takenAt = input.takenAt ?? nowIso();
  const photoHash = input.photoBytes ? photoHashOf(input.photoBytes) : null;
  const dayAgo = new Date(Date.parse(takenAt) - 24 * 3_600_000).toISOString();
  const reused = photoHash ? await db.findReadingByPhotoHash(station.id, photoHash, dayAgo) : null;

  const [previous] = await db.listReadings(station.id, { status: "accepted", limit: 1 });
  const decision = agree(
    {
      aiLevel: input.ai?.level ?? null,
      aiConfidence: input.ai?.confidence ?? null,
      aiIssues: input.ai?.issues ?? [],
      observerLevel: input.observerLevel,
      previous: previous?.level != null ? { level: previous.level, takenAt: previous.takenAt } : null,
      takenAt,
      duplicatePhotoOf: reused ? { takenAt: reused.takenAt } : null,
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
    observerKey: input.observerKey ?? identityKey(input.observerName),
    level: decision.level,
    status: decision.status,
    statusReason: decision.reason,
    photoPath: input.photoPath ?? null,
    photoHash,
    confirmedBy: null,
    confirmedByKey: null,
  });

  if (reading.status === "needs_confirmation") {
    const teamNotified = await requestConfirmation(notifier, station, reading, decision.urgent);
    if (teamNotified === 0) {
      console.warn(`[pipeline] ${station.id}: reading ${reading.id} needs confirmation but the station has no observer team`);
    }
    const provisional = await maybeProvisional(db, notifier, station, reading);
    return { reading, duplicate: false, outcome: null, teamNotified, provisional };
  }
  if (reading.status === "accepted" && opts.runAgent !== false) {
    return {
      reading,
      duplicate: false,
      outcome: await afterAccepted(db, notifier, station, reading),
      teamNotified: null,
      provisional: [],
    };
  }
  return { reading, duplicate: false, outcome: null, teamNotified: null, provisional: [] };
}

export async function afterAccepted(db: Db, notifier: Notifier, station: Station, reading: Reading) {
  return runAlertAgent({ db, notifier, station, readingId: reading.id, now: new Date(), sent: [] });
}

/**
 * The cautious half of a disagreement.
 *
 * When two sources disagree, the lower of them is still a reading somebody took
 * at the river. If even that lower value is above a threshold residents have not
 * been warned about, they are told now — hedged, and explicitly "being checked" —
 * rather than waiting for a volunteer to pick up their phone. The confirmed
 * alert follows when the reading is confirmed.
 */
export async function maybeProvisional(
  db: Db,
  notifier: Notifier,
  station: Station,
  reading: Reading,
): Promise<Alert[]> {
  const candidates = [reading.aiLevel, reading.observerLevel].filter((v): v is number => v != null);
  if (!candidates.length) return [];
  const cautious = Math.min(...candidates);
  const stage: LevelKey = classify(cautious, station.thresholds);
  if (rankOf(stage) === 0) return [];

  const now = new Date();
  const status = await getStationStatus(db, station, now);
  // Only if this is news: above what the gauge last confirmed and above what residents were last told.
  const knownRank = Math.max(rankOf(status.stage ?? "normal"), rankOf(status.lastAlert?.level ?? "normal"));
  if (rankOf(stage) <= knownRank) return [];
  if (status.latest && Date.parse(reading.takenAt) <= Date.parse(status.latest.takenAt)) return [];

  const ctx = { db, notifier, station, readingId: reading.id, now, sent: [] as Alert[] };
  try {
    await sendAlertChecked(ctx, {
      level: stage,
      kind: "provisional",
      origin: "rule",
      status,
      pending: { level: Math.max(...candidates), stage: classify(Math.max(...candidates), station.thresholds) },
    });
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    console.warn(`[pipeline] ${station.id}: provisional warning held back: ${e.message}`);
  }
  return ctx.sent;
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
  args: { readingId: string; action: "accept" | "reject"; level?: number; confirmedBy: string; confirmedByKey?: string | null },
): Promise<{ reading: Reading; outcome: AgentOutcome | null }> {
  const reading = await db.getReading(args.readingId);
  if (!reading) throw new ConfirmError("Reading not found.", 404);
  if (reading.status !== "needs_confirmation") {
    throw new ConfirmError(`Reading is already ${reading.status.replace("_", " ")}.`, 409);
  }

  // Two-person rule: compare stable identities, not free text, so retyping a
  // different spelling of your own name does not get you past it.
  const confirmerKey = args.confirmedByKey ?? identityKey(args.confirmedBy);
  const observerKey = reading.observerKey ?? identityKey(reading.observerName);
  if (!confirmerKey) throw new ConfirmError("Enter your name before confirming a reading.", 400);
  if (observerKey && observerKey === confirmerKey) {
    throw new ConfirmError("A reading must be confirmed by someone other than the observer who sent it.", 403);
  }

  const station = await db.getStation(reading.stationId);
  if (!station) throw new ConfirmError("Station not found.", 404);

  if (args.action === "reject") {
    const updated = await db.updateReading(reading.id, {
      status: "rejected",
      statusReason: `Rejected by ${args.confirmedBy}. ${reading.statusReason}`,
      confirmedBy: args.confirmedBy,
      confirmedByKey: confirmerKey,
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
    confirmedByKey: confirmerKey,
  });
  const outcome = await afterAccepted(db, notifier, station, updated!);
  return { reading: updated!, outcome };
}
