import { describe, expect, it } from "vitest";
import { alertMessage, messageFits } from "../lib/server/messages";
import { ALERT_KINDS } from "../lib/schemas";
import { iso, testStation } from "./helpers";

const base = {
  station: testStation,
  level: 16.2,
  ratePerHour: 0.35,
  takenAt: iso(0),
  stage: "alarm" as const,
};

describe("alert templates", () => {
  it("every kind renders Tagalog and English within Telegram-friendly length", () => {
    for (const kind of ALERT_KINDS) {
      const text = alertMessage(kind, {
        ...base,
        stage: kind === "all-clear" ? "normal" : base.stage,
        eta: { key: "critical", value: 17, minutes: 25 },
        pending: { level: 16.8, stage: "alarm" },
        from: "critical",
      });
      expect(messageFits(text), `${kind}: ${text.length} chars`).toBe(true);
      expect(text).toContain(testStation.name);
    }
  });

  it("tells people where to go once they are asked to move", () => {
    const text = alertMessage("stage", base);
    expect(text).toContain("Barangay Hall");
    expect(text).toContain("MDRRMO 0999");
  });

  it("leaves the evacuation center out of a 1st alarm, which does not ask anyone to move", () => {
    const text = alertMessage("stage", { ...base, stage: "alert", level: 15.2 });
    expect(text).not.toContain("Barangay Hall");
  });

  it("an early warning leads with what is coming, not the current stage", () => {
    const text = alertMessage("early", {
      ...base,
      stage: "normal",
      level: 14.6,
      eta: { key: "alert", value: 15, minutes: 40 },
    });
    expect(text).toMatch(/May reach 1st Alarm/);
    expect(text).not.toMatch(/No action needed/);
  });

  it("a provisional warning says the reading is still being checked", () => {
    const text = alertMessage("provisional", { ...base, stage: "alert", pending: { level: 16.9, stage: "alarm" } });
    expect(text).toMatch(/being checked/);
    expect(text).toMatch(/kinukumpirma/);
  });

  it("messageFits rejects something too short to act on", () => {
    expect(messageFits("baha")).toBe(false);
  });
});
