import { describe, expect, it } from "vitest";
import { classify, nextThreshold } from "../lib/levels";
import { computeTrend, describeTrend } from "../lib/server/trend";

const t = { alert: 15, alarm: 16, critical: 17 };
const base = Date.parse("2026-10-17T10:00:00.000Z");
const pt = (min: number, level: number) => ({ level, takenAt: new Date(base + min * 60_000).toISOString() });

describe("levels", () => {
  it("classifies against thresholds (inclusive)", () => {
    expect(classify(14.99, t)).toBe("normal");
    expect(classify(15, t)).toBe("alert");
    expect(classify(16.5, t)).toBe("alarm");
    expect(classify(17, t)).toBe("critical");
  });

  it("finds the next threshold", () => {
    expect(nextThreshold(14, t)).toEqual({ key: "alert", value: 15 });
    expect(nextThreshold(16.2, t)).toEqual({ key: "critical", value: 17 });
    expect(nextThreshold(17.5, t)).toBeNull();
  });
});

describe("computeTrend", () => {
  it("returns unknown with no data", () => {
    const tr = computeTrend([], t);
    expect(tr.direction).toBe("unknown");
    expect(tr.latest).toBeNull();
  });

  it("needs two points for a rate", () => {
    const tr = computeTrend([pt(0, 14)], t);
    expect(tr.ratePerHour).toBeNull();
    expect(tr.stage).toBe("normal");
  });

  it("measures a steady rise and projects the next threshold", () => {
    // +0.5 m/h: 14.0, 14.25, 14.5 over an hour
    const tr = computeTrend([pt(0, 14), pt(30, 14.25), pt(60, 14.5)], t);
    expect(tr.ratePerHour).toBeCloseTo(0.5, 3);
    expect(tr.direction).toBe("rising");
    expect(tr.eta).toEqual({ key: "alert", value: 15, minutes: 60 });
    expect(describeTrend(tr)).toMatch(/rising \+0.50 m\/h/);
  });

  it("is order-independent and uses a least-squares fit through noise", () => {
    const tr = computeTrend([pt(60, 15.6), pt(0, 15.0), pt(30, 15.35), pt(45, 15.4)], t);
    expect(tr.latest?.level).toBe(15.6);
    expect(tr.ratePerHour!).toBeGreaterThan(0.5);
    expect(tr.ratePerHour!).toBeLessThan(0.7);
    expect(tr.eta?.key).toBe("alarm");
  });

  it("calls small movements steady and does not project", () => {
    const tr = computeTrend([pt(0, 14), pt(60, 14.02)], t);
    expect(tr.direction).toBe("steady");
    expect(tr.eta).toBeNull();
  });

  it("detects a falling river", () => {
    const tr = computeTrend([pt(0, 16.2), pt(60, 15.6)], t);
    expect(tr.direction).toBe("falling");
    expect(tr.ratePerHour).toBeCloseTo(-0.6, 3);
  });

  it("ignores readings outside the window", () => {
    const tr = computeTrend([pt(-300, 10), pt(0, 14), pt(60, 14.5)], t, { windowMinutes: 120 });
    expect(tr.samples).toBe(2);
    expect(tr.ratePerHour).toBeCloseTo(0.5, 3);
  });
});
