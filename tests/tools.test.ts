import { beforeEach, describe, expect, it } from "vitest";
import { isEscalation, runAlertAgent, shouldConsult } from "../lib/server/alertAgent";
import { FileDb, newId } from "../lib/server/db";
import type { Button, Notifier } from "../lib/server/notify";
import { confirmReading, ingestReading } from "../lib/server/pipeline";
import { processReminders } from "../lib/server/reminders";
import { getStationStatus } from "../lib/server/status";
import { executeTool, TOOL_DEFS, type ToolContext, ToolError } from "../lib/server/tools";
import { parseAdvisory } from "../lib/server/pagasa";
import { DEFAULT_STATION } from "../lib/levels";
import type { Reading, Station } from "../lib/schemas";

process.env.AI_MODE = "mock";

class FakeNotifier implements Notifier {
  readonly mode = "log" as const;
  sent: { chatId: string; text: string; buttons?: Button[][] }[] = [];
  async send(chatId: string, text: string, buttons?: Button[][]) {
    this.sent.push({ chatId, text, buttons });
    return true;
  }
  async answerCallback() {}
}

const station: Station = { ...DEFAULT_STATION, teamChatIds: ["team-1"] };
// Pipeline calls use the real clock, so anchor test time to "now".
const T0 = Math.floor(Date.now() / 60_000) * 60_000;
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

function reading(min: number, level: number, status: Reading["status"] = "accepted"): Reading {
  return {
    id: newId(),
    stationId: station.id,
    clientId: null,
    takenAt: iso(min),
    createdAt: iso(min),
    source: "photo",
    aiLevel: level,
    aiConfidence: 0.9,
    aiNotes: null,
    observerLevel: level,
    observerName: "obs",
    level: status === "accepted" ? level : null,
    status,
    statusReason: "test",
    photoPath: null,
    confirmedBy: null,
  };
}

let db: FileDb;
let n: FakeNotifier;
const ctx = (min: number): ToolContext => ({ db, notifier: n, station, readingId: null, now: new Date(T0 + min * 60_000), sent: [] });

beforeEach(async () => {
  db = new FileDb(null);
  n = new FakeNotifier();
  await db.upsertStation(station);
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
});

describe("executeTool", () => {
  it("get_station_status reports stage and trend", async () => {
    await db.insertReading(reading(0, 14.6));
    await db.insertReading(reading(30, 14.9));
    await db.insertReading(reading(60, 15.2));
    const out = (await executeTool("get_station_status", {}, ctx(60))) as Record<string, any>;
    expect(out.stage).toBe("alert");
    expect(out.previous_stage).toBe("normal");
    expect(out.trend.direction).toBe("rising");
    expect(out.trend.next_threshold.key).toBe("alarm");
  });

  it("send_alert broadcasts to subscribers and team and records the alert", async () => {
    await db.insertReading(reading(0, 15.3));
    const c = ctx(0);
    const out = (await executeTool("send_alert", { level: "alert", message: "Mag-ingat: 15.30 m na ang ilog. Be alert." }, c)) as any;
    expect(out.sent).toBe(true);
    expect(out.recipients).toBe(3);
    expect(n.sent.map((m) => m.chatId).sort()).toEqual(["res-1", "res-2", "team-1"]);
    expect(await db.listAlerts(station.id)).toHaveLength(1);
  });

  it("send_alert refuses a level that isn't the current stage", async () => {
    await db.insertReading(reading(0, 15.3));
    await expect(executeTool("send_alert", { level: "critical", message: "Lumikas na! Evacuate now please." }, ctx(0))).rejects.toThrow(
      ToolError,
    );
    expect(n.sent).toHaveLength(0);
  });

  it("send_alert refuses a duplicate within the stage window", async () => {
    await db.insertReading(reading(0, 15.3));
    await executeTool("send_alert", { level: "alert", message: "Mag-ingat: 15.30 m na ang ilog. Be alert." }, ctx(0));
    await expect(
      executeTool("send_alert", { level: "alert", message: "Mag-ingat ulit: 15.30 m. Be alert again." }, ctx(20)),
    ).rejects.toThrow(/already sent/);
    // Allowed again after the 60-minute alert window.
    await db.insertReading(reading(70, 15.35));
    await expect(
      executeTool("send_alert", { level: "alert", message: "Mag-ingat pa rin: 15.35 m. Still at alert." }, ctx(70)),
    ).resolves.toMatchObject({ sent: true });
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
    await db.insertReading(reading(0, 12.0));
    await db.insertReading(reading(60, 12.01));
    const s = await getStationStatus(db, station, new Date(T0 + 60 * 60_000));
    expect(shouldConsult(s, null)).toBeNull();
    const out = await runAlertAgent(ctx(60));
    expect(out.mode).toBe("skipped");
    expect(n.sent).toHaveLength(0);
  });

  it("sends a stage alert on escalation, then stays quiet at the same stage", async () => {
    await db.insertReading(reading(0, 14.8));
    await db.insertReading(reading(15, 15.1));
    const first = await runAlertAgent(ctx(15));
    expect(first.mode).toBe("rule");
    expect(first.alerts.map((a) => a.level)).toEqual(["alert"]);
    expect(first.alerts[0].message).toMatch(/Unang Alarma/);

    await db.insertReading(reading(30, 15.12));
    const second = await runAlertAgent(ctx(30));
    expect(second.alerts).toHaveLength(0);
  });

  it("sends an early warning when the next threshold is near", async () => {
    await db.insertReading(reading(0, 14.0));
    await db.insertReading(reading(30, 14.3));
    await db.insertReading(reading(60, 14.6));
    const out = await runAlertAgent(ctx(60));
    expect(out.alerts).toHaveLength(1);
    expect(out.alerts[0].level).toBe("normal");
    expect(out.alerts[0].message).toMatch(/May reach 1st Alarm/);
    expect(out.alerts[0].message).not.toMatch(/No action needed/);
  });

  it("sends an all-clear after the river drops back", async () => {
    await db.insertReading(reading(0, 15.4));
    await runAlertAgent(ctx(0));
    await db.insertReading(reading(120, 14.6));
    await db.insertReading(reading(180, 14.2));
    const out = await runAlertAgent(ctx(180));
    expect(out.alerts.map((a) => a.level)).toEqual(["normal"]);
    expect(out.alerts[0].message).toMatch(/✅/);
  });

  it("treats a re-rise into a stage as an escalation", async () => {
    await db.insertReading(reading(0, 16.1));
    const s1 = await getStationStatus(db, station, new Date(T0));
    expect(isEscalation(s1)).toBe(true);
    await runAlertAgent(ctx(0));
    await db.insertReading(reading(60, 15.8));
    await db.insertReading(reading(120, 16.2));
    const s2 = await getStationStatus(db, station, new Date(T0 + 120 * 60_000));
    expect(isEscalation(s2)).toBe(true);
  });
});

describe("pipeline", () => {
  it("accepts agreeing readings and alerts residents on escalation", async () => {
    await db.insertReading(reading(-30, 14.8));
    const res = await ingestReading(db, n, {
      station,
      source: "photo",
      ai: { level: 15.22, confidence: 0.92, notes: "", mode: "mock" },
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
      ai: { level: 12.0, confidence: 0.9, notes: "", mode: "mock" as const },
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
      ai: { level: 16.4, confidence: 0.9, notes: "", mode: "mock" },
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
});

describe("reminders", () => {
  it("nudges the team when readings are overdue at an elevated stage, without nagging", async () => {
    await db.insertReading(reading(0, 16.2)); // alarm stage: every 30 min
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
    expect(parseAdvisory('{"warning":"Orange","text":"Orange warning NCR"}')).toEqual({ warning: "orange", text: "Orange warning NCR" });
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
    await db.insertReading(reading(-60, 14.2));
    await ingestReading(db, n, { station, source: "photo", ai: null, observerLevel: 15.1, observerName: "Juan" });
    const s = await getStationStatus(db, station);
    expect(s.stage).toBe("normal");
    expect(s.pendingHighest).toMatchObject({ level: 15.1, stage: "alert" });
  });
});
