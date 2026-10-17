import type { ReadingStatus, Station } from "../schemas";

export interface AgreeInput {
  aiLevel: number | null;
  aiConfidence: number | null;
  observerLevel: number | null;
  /** Last accepted reading at this station, used for the jump check. */
  previous?: { level: number; takenAt: string } | null;
  takenAt: string;
}

export interface AgreeResult {
  status: ReadingStatus;
  /** Level to record; null unless accepted. */
  level: number | null;
  reason: string;
  /** True when an unconfirmed value is at or above the critical threshold — confirm fast. */
  urgent: boolean;
}

/** AI reads below this confidence never stand on their own. */
export const MIN_SOLO_CONFIDENCE = 0.85;
/** A real river rarely moves faster than this; bigger jumps need a human look. */
export const MAX_RATE_M_PER_HOUR = 2;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Decide whether a reading can be trusted automatically.
 *
 * Two independent sources (the AI reading the photo and the observer's own
 * eyeball reading) must agree within the station tolerance. Anything doubtful
 * is routed to a human instead of being silently accepted or dropped.
 */
export function agree(input: AgreeInput, station: Station): AgreeResult {
  const { aiLevel, aiConfidence, observerLevel } = input;
  const candidates = [aiLevel, observerLevel].filter((v): v is number => v != null);
  const urgent = candidates.some((v) => v >= station.thresholds.critical);

  if (candidates.length === 0) {
    return { status: "rejected", level: null, reason: "No readable level from photo or observer.", urgent: false };
  }

  const outOfRange = candidates.find((v) => v < station.gaugeMin - 0.5 || v > station.gaugeMax + 0.5);
  if (outOfRange != null) {
    return {
      status: "needs_confirmation",
      level: null,
      reason: `Value ${outOfRange.toFixed(2)} m is outside the gauge range (${station.gaugeMin}–${station.gaugeMax} m).`,
      urgent,
    };
  }

  let level: number;
  let reason: string;

  if (aiLevel != null && observerLevel != null) {
    const diff = Math.abs(aiLevel - observerLevel);
    if (diff > station.tolerance + 1e-9) {
      return {
        status: "needs_confirmation",
        level: null,
        reason: `AI (${aiLevel.toFixed(2)} m) and observer (${observerLevel.toFixed(2)} m) differ by ${diff.toFixed(2)} m (tolerance ${station.tolerance} m).`,
        urgent,
      };
    }
    // Observer is on site and sees the whole gauge; AI agrees within tolerance.
    level = observerLevel;
    reason = `AI and observer agree within ${diff.toFixed(2)} m.`;
  } else if (aiLevel != null) {
    const conf = aiConfidence ?? 0;
    if (conf < MIN_SOLO_CONFIDENCE) {
      return {
        status: "needs_confirmation",
        level: null,
        reason: `AI-only reading with confidence ${conf.toFixed(2)} (< ${MIN_SOLO_CONFIDENCE}); needs a human check.`,
        urgent,
      };
    }
    level = aiLevel;
    reason = `AI-only reading with confidence ${conf.toFixed(2)}.`;
  } else {
    return {
      status: "needs_confirmation",
      level: null,
      reason: "Only the observer's reading is available (photo unreadable); needs a second person.",
      urgent,
    };
  }

  const prev = input.previous;
  if (prev) {
    const hours = Math.max((Date.parse(input.takenAt) - Date.parse(prev.takenAt)) / 3_600_000, 0.25);
    const rate = Math.abs(level - prev.level) / hours;
    if (rate > MAX_RATE_M_PER_HOUR) {
      return {
        status: "needs_confirmation",
        level: null,
        reason: `Change of ${(level - prev.level).toFixed(2)} m since last reading is implausibly fast (${rate.toFixed(1)} m/h).`,
        urgent,
      };
    }
  }

  return { status: "accepted", level: round2(level), reason, urgent: false };
}
