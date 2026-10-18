import { describe, expect, it } from "vitest";
import { DEFAULT_STATION } from "../lib/levels";
import { agree, MIN_SOLO_CONFIDENCE } from "../lib/server/agree";

const st = DEFAULT_STATION; // gauge 10–22 m, thresholds 15/16/17, tolerance 0.10
const at = "2026-10-17T10:00:00.000Z";

describe("agree", () => {
  it("accepts when AI and observer agree within tolerance, using the observer's value", () => {
    const r = agree({ aiLevel: 15.42, aiConfidence: 0.9, observerLevel: 15.4, takenAt: at }, st);
    expect(r.status).toBe("accepted");
    expect(r.level).toBe(15.4);
  });

  it("accepts exactly at the tolerance boundary", () => {
    const r = agree({ aiLevel: 15.5, aiConfidence: 0.9, observerLevel: 15.4, takenAt: at }, st);
    expect(r.status).toBe("accepted");
  });

  it("asks for confirmation when they disagree", () => {
    const r = agree({ aiLevel: 15.7, aiConfidence: 0.95, observerLevel: 15.4, takenAt: at }, st);
    expect(r.status).toBe("needs_confirmation");
    expect(r.level).toBeNull();
    expect(r.reason).toMatch(/differ by 0.30/);
  });

  it("flags disagreement near the critical level as urgent", () => {
    const r = agree({ aiLevel: 17.3, aiConfidence: 0.9, observerLevel: 16.8, takenAt: at }, st);
    expect(r.status).toBe("needs_confirmation");
    expect(r.urgent).toBe(true);
  });

  it("accepts a confident AI-only reading", () => {
    const r = agree({ aiLevel: 14.2, aiConfidence: MIN_SOLO_CONFIDENCE, observerLevel: null, takenAt: at }, st);
    expect(r.status).toBe("accepted");
    expect(r.level).toBe(14.2);
  });

  it("holds an unsure AI-only reading", () => {
    const r = agree({ aiLevel: 14.2, aiConfidence: 0.6, observerLevel: null, takenAt: at }, st);
    expect(r.status).toBe("needs_confirmation");
  });

  it("holds an observer-only reading for a second person", () => {
    const r = agree({ aiLevel: null, aiConfidence: null, observerLevel: 14.2, takenAt: at }, st);
    expect(r.status).toBe("needs_confirmation");
  });

  it("rejects when there is nothing to go on", () => {
    expect(agree({ aiLevel: null, aiConfidence: null, observerLevel: null, takenAt: at }, st).status).toBe("rejected");
  });

  it("holds values outside the gauge range", () => {
    const r = agree({ aiLevel: 25, aiConfidence: 0.99, observerLevel: 25, takenAt: at }, st);
    expect(r.status).toBe("needs_confirmation");
    expect(r.reason).toMatch(/outside the gauge range/);
  });

  it("holds implausibly fast jumps since the last reading", () => {
    const previous = { level: 13.0, takenAt: "2026-10-17T09:30:00.000Z" };
    const r = agree({ aiLevel: 15.0, aiConfidence: 0.95, observerLevel: 15.0, previous, takenAt: at }, st);
    expect(r.status).toBe("needs_confirmation");
    expect(r.reason).toMatch(/implausibly fast/);
  });

  it("allows a fast but realistic rise", () => {
    const previous = { level: 14.5, takenAt: "2026-10-17T09:30:00.000Z" };
    const r = agree({ aiLevel: 15.0, aiConfidence: 0.95, observerLevel: 15.02, previous, takenAt: at }, st);
    expect(r.status).toBe("accepted");
  });

  it("gives a flash flood more room when both sources read the same number", () => {
    const previous = { level: 13.8, takenAt: "2026-10-17T09:30:00.000Z" };
    // 2.4 m/h: above the station limit, but two people and the AI agree on it.
    const agreed = agree({ aiLevel: 15.0, aiConfidence: 0.95, observerLevel: 15.0, previous, takenAt: at }, st);
    expect(agreed.status).toBe("accepted");
    // The same jump from the AI alone still waits for a human.
    const solo = agree({ aiLevel: 15.0, aiConfidence: 0.95, observerLevel: null, previous, takenAt: at }, st);
    expect(solo.status).toBe("needs_confirmation");
    expect(solo.reason).toMatch(/implausibly fast/);
  });

  it("holds an AI-only reading from a photo the model itself called bad", () => {
    const r = agree(
      { aiLevel: 14.2, aiConfidence: 0.99, aiIssues: ["glare", "waves"], observerLevel: null, takenAt: at },
      st,
    );
    expect(r.status).toBe("needs_confirmation");
    expect(r.reason).toMatch(/glare/);
  });

  it("photo problems do not override an observer who agrees", () => {
    const r = agree(
      { aiLevel: 14.2, aiConfidence: 0.7, aiIssues: ["glare"], observerLevel: 14.25, takenAt: at },
      st,
    );
    expect(r.status).toBe("accepted");
  });

  it("holds a photo that was already sent", () => {
    const r = agree(
      {
        aiLevel: 14.2,
        aiConfidence: 0.95,
        observerLevel: 14.2,
        takenAt: at,
        duplicatePhotoOf: { takenAt: "2026-10-17T09:00:00.000Z" },
      },
      st,
    );
    expect(r.status).toBe("needs_confirmation");
    expect(r.reason).toMatch(/already sent/);
  });

  it("respects a station's own idea of a plausible rise", () => {
    const slow = { ...st, maxRatePerHour: 0.5 };
    const previous = { level: 14.5, takenAt: "2026-10-17T09:30:00.000Z" };
    const r = agree({ aiLevel: 15.0, aiConfidence: 0.95, observerLevel: 15.0, previous, takenAt: at }, slow);
    expect(r.status).toBe("needs_confirmation");
  });
});
