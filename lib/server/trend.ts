import { classify, nextThreshold } from "../levels";
import type { LevelKey, Thresholds } from "../schemas";

export interface TrendPoint {
  level: number;
  takenAt: string;
}

export interface Trend {
  latest: TrendPoint | null;
  stage: LevelKey | null;
  /** Least-squares slope over the window, metres per hour. */
  ratePerHour: number | null;
  direction: "rising" | "falling" | "steady" | "unknown";
  samples: number;
  windowMinutes: number;
  /** Projected time until the next threshold is crossed, if rising. */
  eta: { key: LevelKey; value: number; minutes: number } | null;
}

/** Slower than this (m/h) counts as steady. */
export const STEADY_BAND = 0.05;

export function computeTrend(
  points: TrendPoint[],
  thresholds: Thresholds,
  opts: { now?: Date; windowMinutes?: number } = {},
): Trend {
  const windowMinutes = opts.windowMinutes ?? 120;
  const sorted = [...points].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
  const latest = sorted.at(-1) ?? null;

  const base: Trend = {
    latest,
    stage: latest ? classify(latest.level, thresholds) : null,
    ratePerHour: null,
    direction: "unknown",
    samples: 0,
    windowMinutes,
    eta: null,
  };
  if (!latest) return base;

  const end = opts.now ? opts.now.getTime() : Date.parse(latest.takenAt);
  const start = end - windowMinutes * 60_000;
  const inWindow = sorted.filter((p) => {
    const t = Date.parse(p.takenAt);
    return t >= start && t <= end;
  });
  base.samples = inWindow.length;
  if (inWindow.length < 2) return base;

  const t0 = Date.parse(inWindow[0].takenAt);
  const xs = inWindow.map((p) => (Date.parse(p.takenAt) - t0) / 3_600_000);
  const ys = inWindow.map((p) => p.level);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return base;

  const rate = num / den;
  base.ratePerHour = Math.round(rate * 1000) / 1000;
  base.direction = rate > STEADY_BAND ? "rising" : rate < -STEADY_BAND ? "falling" : "steady";

  if (base.direction === "rising") {
    const next = nextThreshold(latest.level, thresholds);
    if (next) {
      base.eta = { ...next, minutes: Math.round(((next.value - latest.level) / rate) * 60) };
    }
  }
  return base;
}

export function describeTrend(t: Trend): string {
  if (t.ratePerHour == null) return "not enough recent readings for a trend";
  const r = `${t.ratePerHour >= 0 ? "+" : ""}${t.ratePerHour.toFixed(2)} m/h`;
  const eta = t.eta ? `, ${t.eta.key} level (${t.eta.value} m) in ~${t.eta.minutes} min` : "";
  return `${t.direction} ${r} over ${t.samples} readings${eta}`;
}
