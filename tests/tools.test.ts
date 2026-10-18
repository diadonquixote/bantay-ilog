import { beforeEach, describe, expect, it } from "vitest";
import { isEscalation, runAlertAgent, shouldConsult } from "../lib/server/alertAgent";
import type { FileDb } from "../lib/server/db";
import { parseAdvisory } from "../lib/server/pagasa";
import { confirmReading, ingestReading } from "../lib/server/pipeline";
import { processReminders } from "../lib/server/reminders";
import { getStationStatus } from "../lib/server/status";
import { executeTool, TOOL_DEFS, type ToolContext, ToolError } from "../lib/server/tools";
import { FakeNotifier, freshDb, iso, reading, T0, testStation as station } from "./helpers";

process.env.AI_MODE = "mock";

let db: FileDb;
let n: FakeNotifier;
const ctx = (min: number): ToolContext => ({
  db,
  notifier: n,
  station,
  readingId: null,
  now: new Date(T0 + min * 60_000),
  sent: [],
});

beforeEach(async () => {
  db = await freshDb();
  n = new FakeNotifier();
  await db.addSubscriber({ chatId: "res-1", stationId: station.id, name: "Resident", createdAt: iso(0) });
  await db.addSubscriber({ chatId: "res-2", stationId: station.id, name: "Resident 2", createdAt: iso(0) });
});

describe("tool definitions", () => {
  it("are strict, closed object schemas", () => {
    for (const t of TOOL_DEFS) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.type).toBe("object");
      expect((t.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });

  it("does not let the model write the text residents receive", () => {
    const send = TOOL_DEFS.find((t) => t.name === "send_alert")!;
    expect(Object.keys((send.input_schema as { properties: object }).properties)).toEqual(["level", "kind"]);
  });
});

describe("executeTool", () => {
  it("get_station_status reports stage, trend and freshness", async () => {
    await db.insertReading(reading(14.6, { min: 0 }));
    await db.insertReading(reading(14.9, { min: 30 }));
    await db.insertReading(reading(15.2, { min: 60 }));
    const out = (await executeTool("get_station_status", {}, ctx(60))) as Record<string, any>;
    expect(out.stage).toBe("alert");
    expect(out.previous_stage).toBe("normal");
    expect(out.trend.direction).toBe("rising");
    expect(out.trend.next_threshold.key).toBe("alarm");
    expect(out.reading_is_stale).toBe(false);
    expect(out.latest.age_minutes).toBe(0);
  });

  it("send_alert broadcasts to subscribers and team and records the alert", async () => {
    await db.insertReading(reading(15.3, { min: 0 }));
    const out = (await executeTool("send_alert", { level: "alert", kind: "stage" }, ctx(0))) as any;
    expect(out.sent).toBe(true);
    expect(out.recipients).toBe(3);
    expect(n.sent.map((m) => m.chatId).sort()).toEqual(["res-1", "res-2", "team-1"]);
    const [alert] = await db.listAlerts(station.id);
    expect(alert.recipients).toBe(3);
    // Bilingual, from the template, with the station's own hotline.
    expect(alert.message).toMatch(/Unang Alarma/);
    expect(alert.message).toMatch(/1st Alarm/);
    expect(alert.message).toMatch(/MDRRMO 0999/);
  });

  it("send_alert refuses a level that isn't the current stage", async () => {
    await db.insertReading(reading(15.3, { min: 0 }));
    await expect(executeTool("send_alert", { level: "critical", kind: "stage" }, ctx(0))).rejects.toThrow(ToolError);
    expect(n.sent).toHaveLength(0);
  });

  it("send_alert refuses a reading too old to act on", async () => {
    await db.insertReading(reading(15.3, { min: 0 }));
    await expect(executeTool("send_alert", { level: "alert", kind: "stage" }, ctx(200))).rejects.toThrow(/old/);
  });

  it("send_alert refuses a duplicate within the stage window", async () => {
    await db.insertReading(reading(15.3, { min: 0 }));
    await executeTool("send_alert", { level: "alert", kind: "stage" }, ctx(0));
    await expect(executeTool("send_alert", { level: "alert", kind: "stage" }, ctx(20))).rejects.toThrow(/already sent/);
    // Allowed again after the 60-minute alert window.
    await db.insertReading(reading(15.35, { min: 70 }));
    await expect(executeTool("send_alert", { level: "alert", kind: "stage" }, ctx(70))).resolves.toMatchObject({ sent: true });
  });

  it("preview_alert shows the text without sending it", async () => {
    await db.insertReading(reading(15.3, { min: 0 }));
    const out = (await executeTool("preview_alert", { kind: "stage" }, ctx(0))) as any;
    expect(out.message).toMatch(/1st Alarm/);
    expect(n.sent).toHaveLength(0);
    expect(await db.listAlerts(station.id)).toHaveLength(0);
  });

  it("schedule_reading_reminder clamps and stores a reminder", async () => {
    const out = (await executeTool("schedule_reading_reminder", { minutes_from_now: 1, reason: "steep rise" }, ctx(0))) as any;
    expect(out.scheduled).toBe(true);
    const [r] = await db.listReminders({ stationId: station.id });
    expect(Date.parse(r.dueAt) - T0).toBe(5 * 60_000);
  });

  it("unknown tools are a correctable error", async () => {
    await expect(executeTool("delete_everything", {}, ctx(0))).rejects.toThrow(ToolError);
  });
});

describe("alert decisions (rule mode)", () => {
  it("does not consult on a calm, steady river", async () => {
    await db.insertReading(reading(12.0, { min: 0 }));
    await db.insertReading(reading(12.01, { min: 60 }));
    const s = await getStationStatus(db, station, new Date(T0 + 60 * 60_000));
    expect(shouldConsult(s, null)).toBeNull();
    const out = await runAlertAgent(ctx(60));
    expect(out.mode).toBe("skipped");
    expect(n.sent).toHaveLength(0);
  });

  it("sends a stage alert on escalation, then stays quiet at the same stage", async () => {
    await db.insertReading(reading(14.8, { min: 0 }));
    await db.insertReading(reading(15.1, { min: 15 }));
    const first = await runAlertAgent(ctx(15));
    expect(first.mode).toBe("rule");
    expect(first.alerts.map((a) => a.level)).toEqual(["alert"]);
    expect(first.alerts[0].kind).toBe("stage");
    expect(first.alerts[0].message).toMatch(/Unang Alarma/);

    await db.insertReading(reading(15.12, { min: 30 }));
    const second = await runAlertAgent(ctx(30));
    expect(second.alerts).toHaveLength(0);
  });

  it("sends an early warning when the next threshold is near", async () => {
    await db.insertReading(reading(14.0, { min: 0 }));
    await db.insertReading(reading(14.3, { min: 30 }));
    await db.insertReading(reading(14.6, { min: 60 }));
    const out = await runAlertAgent(ctx(60));
    expect(out.alerts).toHaveLength(1);
    expect(out.alerts[0].kind).toBe("early");
    expect(out.alerts[0].message).toMatch(/May reach 1st Alarm/);
    expect(out.alerts[0].message).not.toMatch(/No action needed/);
  });

  it("does not follow a stage alert with an early warning minutes later", async () => {
    await db.insertReading(reading(14.8, { min: 0 }));
    await db.insertReading(reading(15.1, { min: 15 }));
    expect((await runAlertAgent(ctx(15))).alerts.map((a) => a.kind)).toEqual(["stage"]);

    // Still rising towards the 2nd alarm, but residents were just messaged.
    await db.insertReading(reading(15.4, { min: 30 }));
    const soon = await runAlertAgent(ctx(30));
    expect(soon.alerts).toHaveLength(0);
    expect(soon.summary).toMatch(/waits 30 min/);

    // Once the quiet period has passed, the warning that the next stage is
    // coming is new information and does go out.
    await db.insertReading(reading(15.7, { min: 50 }));
    const later = await runAlertAgent(ctx(50));
    expect(later.alerts.map((a) => a.kind)).toEqual(["early"]);
  });

  it("waits for a second normal reading before the all-clear", async () => {
    await db.insertReading(reading(15.4, { min: 0 }));
    await runAlertAgent(ctx(0));
    n.sent.length = 0;

    await db.insertReading(reading(14.6, { min: 120 }));
    const tooSoon = await runAlertAgent(ctx(120));
    expect(tooSoon.alerts).toHaveLength(0);
    expect(tooSoon.summary).toMatch(/second confirming reading/);

    await db.insertReading(reading(14.2, { min: 180 }));
    const out = await runAlertAgent(ctx(180));
    expect(out.alerts.map((a) => a.kind)).toEqual(["all-clear"]);
    expect(out.alerts[0].message).toMatch(/✅/);
  });

  it("does not call off an emergency while the river sits on the threshold", async () => {
    await db.insertReading(reading(15.4, { min: 0 }));
    await runAlertAgent(ctx(0));
    // 14.95 m is below the 15 m line but inside the margin: not an all-clear.
    await db.insertReading(reading(14.95, { min: 60 }));
    await db.insertReading(reading(14.97, { min: 90 }));
    const out = await runAlertAgent(ctx(90));
    expect(out.alerts).toHaveLength(0);
  });

  it("warns that a fall to a lower stage is still dangerous", async () => {
    await db.insertReading(reading(17.2, { min: 0 }));
    await runAlertAgent(ctx(0));
    await db.insertReading(reading(16.4, { min: 30 }));
    await db.insertReading(reading(16.2, { min: 60 }));
    const out = await runAlertAgent(ctx(60));
    expect(out.alerts.map((a) => a.kind)).toEqual(["de-escalation"]);
    expect(out.alerts[0].message).toMatch(/do not return/i);
  });

  it("treats a re-rise into a stage as an escalation", async () => {
    await db.insertReading(reading(16.1, { min: 0 }));
    const s1 = await getStationStatus(db, station, new Date(T0));
    expect(isEscalation(s1)).toBe(true);
    await runAlertAgent(ctx(0));
    await db.insertReading(reading(15.8, { min: 60 }));
    await db.insertReading(reading(16.2, { min: 120 }));
    const s2 = await getStationStatus(db, station, new Date(T0 + 120 * 60_000));
    expect(isEscalation(s2)).toBe(true);
  });
});

describe("pipeline", () => {
  it("accepts agreeing readings and alerts residents on escalation", async () => {
    await db.insertReading(reading(14.8, { min: -30 }));
    const res = await ingestReading(db, n, {
      station,
      source: "photo",
      ai: { level: 15.22, confidence: 0.92, notes: "", issues: [], mode: "mock" },
      observerLevel: 15.2,
      observerName: "Juan",
    });
    expect(res.reading.status).toBe("accepted");
    expect(res.outcome?.alerts).toHaveLength(1);
  });

  it("is idempotent on clientId", async () => {
    const input = {
      station,
      source: "photo" as const,
      ai: { level: 12.0, confidence: 0.9, notes: "", issues: [], mode: "mock" as const },
      observerLevel: 12.0,
      observerName: "Juan",
      clientId: "abc",
    };
    const a = await ingestReading(db, n, input);
    const b = await ingestReading(db, n, input);
    expect(b.duplicate).toBe(true);
    expect(b.reading.id).toBe(a.reading.id);
    expect(await db.listReadings(station.id)).toHaveLength(1);
  });

  it("sends disagreements to the team with confirm buttons, and confirmation triggers alerts", async () => {
    const res = await ingestReading(db, n, {
      station,
      source: "photo",
      ai: { level: 16.4, confidence: 0.9, notes: "", issues: [], mode: "mock" },
      observerLevel: 15.9,
      observerName: "Juan",
    });
    expect(res.reading.status).toBe("needs_confirmation");
    const req = n.sent.find((m) => m.chatId === "team-1")!;
    expect(req.buttons?.flat().map((b) => b.data)).toEqual([
      `c:${res.reading.id}:16.4`,
      `c:${res.reading.id}:15.9`,
      `x:${res.reading.id}`,
    ]);
    for (const b of req.buttons!.flat()) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(64);

    await expect(
      confirmReading(db, n, { readingId: res.reading.id, action: "accept", level: 16.4, confirmedBy: "Juan" }),
    ).rejects.toThrow(/someone other than/);

    const ok = await confirmReading(db, n, { readingId: res.reading.id, action: "accept", level: 16.4, confirmedBy: "Maria" });
    expect(ok.reading.status).toBe("accepted");
    expect(ok.outcome?.alerts.map((a) => a.level)).toEqual(["alarm"]);

    await expect(
      confirmReading(db, n, { readingId: res.reading.id, action: "reject", confirmedBy: "Maria" }),
    ).rejects.toThrow(/already accepted/);
  });

  it("does not let the same person confirm their own reading under another spelling", async () => {
    const res = await ingestReading(db, n, {
      station,
      source: "photo",
      ai: { level: 16.4, confidence: 0.9, notes: "", issues: [], mode: "mock" },
      observerLevel: 15.9,
      observerName: "Juan Dela Cruz",
    });
    await expect(
      confirmReading(db, n, { readingId: res.reading.id, action: "accept", level: 16.4, confirmedBy: "  juan   dela cruz " }),
    ).rejects.toThrow(/someone other than/);
  });

  it("refuses the same photo sent twice", async () => {
    const photoBytes = Buffer.from("a gauge photo");
    const first = await ingestReading(db, n, {
      station,
      source: "photo",
      ai: { level: 12.0, confidence: 0.95, notes: "", issues: [], mode: "mock" },
      observerLevel: 12.0,
      observerName: "Juan",
      photoBytes,
    });
    expect(first.reading.status).toBe("accepted");
    const again = await ingestReading(db, n, {
      station,
      source: "photo",
      ai: { level: 12.0, confidence: 0.95, notes: "", issues: [], mode: "mock" },
      observerLevel: 12.0,
      observerName: "Juan",
      photoBytes,
    });
    expect(again.reading.status).toBe("needs_confirmation");
    expect(again.reading.statusReason).toMatch(/already sent/);
  });
});

describe("provisional warnings", () => {
  it("warns residents at the cautious stage while a high reading is checked", async () => {
    await db.insertReading(reading(14.2, { min: -60 }));
    const res = await ingestReading(db, n, {
      station,
      source: "photo",
      // Two sources disagree across a threshold: the lower one still says 1st alarm.
      ai: { level: 17.2, confidence: 0.9, notes: "", issues: [], mode: "mock" },
      observerLevel: 15.4,
      observerName: "Juan",
    });
    expect(res.reading.status).toBe("needs_confirmation");
    expect(res.provisional.map((a) => a.level)).toEqual(["alert"]);
    expect(res.provisional[0].message).toMatch(/kinukumpirma|being checked/);
    expect(n.sent.some((m) => m.chatId === "res-1")).toBe(true);
  });

  it("stays quiet when the cautious reading is normal", async () => {
    const res = await ingestReading(db, n, {
      station,
      source: "photo",
      ai: { level: 16.9, confidence: 0.9, notes: "", issues: [], mode: "mock" },
      observerLevel: 14.2,
      observerName: "Juan",
    });
    expect(res.provisional).toHaveLength(0);
    expect(n.sent.some((m) => m.chatId === "res-1")).toBe(false);
  });

  it("stays quiet when residents already know about that stage", async () => {
    await db.insertReading(reading(15.6, { min: -30 }));
    await runAlertAgent(ctx(-30));
    n.sent.length = 0;
    const res = await ingestReading(db, n, {
      station,
      source: "photo",
      ai: { level: 16.4, confidence: 0.9, notes: "", issues: [], mode: "mock" },
      observerLevel: 15.5,
      observerName: "Juan",
    });
    expect(res.provisional).toHaveLength(0);
  });
});

describe("reminders", () => {
  it("nudges the team when readings are overdue at an elevated stage, without nagging", async () => {
    await db.insertReading(reading(16.2, { min: 0 })); // alarm stage: every 30 min
    expect(await processReminders(db, n, new Date(T0 + 20 * 60_000))).toEqual({ explicit: 0, cadence: 0 });
    expect(await processReminders(db, n, new Date(T0 + 35 * 60_000))).toEqual({ explicit: 0, cadence: 1 });
    expect(await processReminders(db, n, new Date(T0 + 45 * 60_000))).toEqual({ explicit: 0, cadence: 0 });
    expect(n.sent.filter((m) => m.chatId === "team-1")).toHaveLength(1);
  });

  it("delivers scheduled reminders once", async () => {
    await executeTool("schedule_reading_reminder", { minutes_from_now: 10, reason: "steep rise" }, ctx(0));
    expect((await processReminders(db, n, new Date(T0 + 5 * 60_000))).explicit).toBe(0);
    expect((await processReminders(db, n, new Date(T0 + 11 * 60_000))).explicit).toBe(1);
    expect((await processReminders(db, n, new Date(T0 + 12 * 60_000))).explicit).toBe(0);
  });
});

describe("parseAdvisory", () => {
  it("reads JSON", () => {
    expect(parseAdvisory('{"warning":"Orange","text":"Orange warning NCR"}')).toEqual({
      warning: "orange",
      text: "Orange warning NCR",
    });
  });
  it("scans HTML bulletins for the highest warning", () => {
    const html = "<html><body><p>YELLOW rainfall warning in Rizal.</p><p>RED RAINFALL WARNING over Metro Manila</p></body></html>";
    expect(parseAdvisory(html).warning).toBe("red");
  });
  it("returns none when no warning is mentioned", () => {
    expect(parseAdvisory("<p>Fair weather</p>").warning).toBe("none");
  });
});

describe("unconfirmed readings", () => {
  it("reports when nobody on the team could be asked to confirm", async () => {
    const noTeam = { ...station, teamChatIds: [] };
    await db.upsertStation(noTeam);
    const res = await ingestReading(db, n, {
      station: noTeam,
      source: "photo",
      ai: null,
      observerLevel: 15.1,
      observerName: "Juan",
    });
    expect(res.reading.status).toBe("needs_confirmation");
    expect(res.teamNotified).toBe(0);
  });

  it("tells the team when an unconfirmed value is above a threshold", async () => {
    const res = await ingestReading(db, n, { station, source: "photo", ai: null, observerLevel: 15.1, observerName: "Juan" });
    expect(res.teamNotified).toBe(1);
    expect(n.sent[0].text).toMatch(/If confirmed this is 1st Alarm/);
  });

  it("surfaces the highest pending value in station status", async () => {
    await db.insertReading(reading(14.2, { min: -60 }));
    await ingestReading(db, n, { station, source: "photo", ai: null, observerLevel: 15.1, observerName: "Juan" });
    const s = await getStationStatus(db, station);
    expect(s.stage).toBe("normal");
    expect(s.pendingHighest).toMatchObject({ level: 15.1, stage: "alert" });
  });
});
