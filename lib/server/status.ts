import { classify } from "../levels";
import type { Alert, LevelKey, Reading, Station } from "../schemas";
import type { Db } from "./db";
import { computeTrend, type Trend } from "./trend";

export interface StationStatus {
  station: Station;
  latest: Reading | null;
  stage: LevelKey | null;
  /** Stage of the accepted reading before the latest one. */
  previousStage: LevelKey | null;
  /** How many of the most recent accepted readings in a row share the current stage. */
  stageRun: number;
  /** Age of the latest confirmed reading, in minutes. */
  ageMinutes: number | null;
  trend: Trend;
  pendingConfirmations: number;
  /** The highest value among readings still waiting for confirmation (AI or observer, whichever is higher). */
  pendingHighest: { readingId: string; level: number; stage: LevelKey; takenAt: string } | null;
  lastAlert: Alert | null;
}

const HOUR = 3_600_000;

/** A reading older than this is not a picture of the river right now. */
export const STALE_AFTER_MIN = 90;

export async function getStationStatus(db: Db, station: Station, now = new Date()): Promise<StationStatus> {
  const accepted = await db.listReadings(station.id, {
    status: "accepted",
    sinceIso: new Date(now.getTime() - 48 * HOUR).toISOString(),
  });
  const pending = await db.listReadings(station.id, {
    status: "needs_confirmation",
    sinceIso: new Date(now.getTime() - 24 * HOUR).toISOString(),
  });
  const alerts = await db.listAlerts(station.id);

  let pendingHighest: StationStatus["pendingHighest"] = null;
  for (const r of pending) {
    const v = Math.max(r.aiLevel ?? -Infinity, r.observerLevel ?? -Infinity);
    if (Number.isFinite(v) && (!pendingHighest || v > pendingHighest.level)) {
      pendingHighest = { readingId: r.id, level: v, stage: classify(v, station.thresholds), takenAt: r.takenAt };
    }
  }

  const points = accepted.filter((r) => r.level != null).map((r) => ({ level: r.level!, takenAt: r.takenAt }));
  const latest = accepted[0] ?? null;
  const prev = accepted[1] ?? null;
  const stage = latest?.level != null ? classify(latest.level, station.thresholds) : null;

  let stageRun = 0;
  if (stage) {
    for (const r of accepted) {
      if (r.level == null || classify(r.level, station.thresholds) !== stage) break;
      stageRun++;
    }
  }

  return {
    station,
    latest,
    stage,
    previousStage: prev?.level != null ? classify(prev.level, station.thresholds) : null,
    stageRun,
    ageMinutes: latest ? Math.round((now.getTime() - Date.parse(latest.takenAt)) / 60_000) : null,
    trend: computeTrend(points, station.thresholds, { now }),
    pendingConfirmations: pending.length,
    pendingHighest,
    lastAlert: alerts[0] ?? null,
  };
}

export function isStale(s: StationStatus): boolean {
  return s.ageMinutes != null && s.ageMinutes > STALE_AFTER_MIN;
}
