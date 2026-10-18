import { beforeEach, describe, expect, it } from "vitest";
import { DuplicateAlertError, type FileDb } from "../lib/server/db";
import { broadcastToSubscribers, deliverPending } from "../lib/server/notify";
import { sendAlertChecked, type ToolContext, ToolError } from "../lib/server/tools";
import type { Alert } from "../lib/schemas";
import { FakeNotifier, freshDb, iso, reading, T0, testStation as station } from "./helpers";

process.env.AI_MODE = "mock";

let db: FileDb;
let n: FakeNotifier;
const ctx = (): ToolContext => ({ db, notifier: n, station, readingId: null, now: new Date(T0), sent: [] });

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: crypto.randomUUID(),
  stationId: station.id,
  readingId: null,
  level: "alert",
  kind: "stage",
  message: "x".repeat(40),
  origin: "rule",
  recipients: 0,
  dedupeKey: "sto-nino|stage|alert|1",
  createdAt: iso(0),
  ...over,
});

beforeEach(async () => {
  db = await freshDb();
  n = new FakeNotifier();
});

describe("alert de-duplication", () => {
  it("the store refuses a second alert with the same dedupe key", async () => {
    await db.insertAlert(alert());
    await expect(db.insertAlert(alert())).rejects.toBeInstanceOf(DuplicateAlertError);
    expect(await db.listAlerts(station.id)).toHaveLength(1);
  });

  it("two alert runs racing each other send one message, not two", async () => {
    await db.insertReading(reading(15.3, { min: 0 }));
    const results = await Promise.allSettled([
      sendAlertChecked(ctx(), { level: "alert", kind: "stage", origin: "rule" }),
      sendAlertChecked(ctx(), { level: "alert", kind: "stage", origin: "rule" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ToolError);
    expect(await db.listAlerts(station.id)).toHaveLength(1);
  });
});

describe("broadcast", () => {
  it("drops a subscriber that has blocked the bot", async () => {
    await db.addSubscriber({ chatId: "res-1", stationId: station.id, name: null, createdAt: iso(0) });
    await db.addSubscriber({ chatId: "res-2", stationId: station.id, name: null, createdAt: iso(0) });
    n.blocked.add("res-2");

    const reached = await broadcastToSubscribers(db, n, station.id, "Tumataas ang ilog / River rising");
    expect(reached).toBe(1);
    expect((await db.listSubscribers(station.id)).map((s) => s.chatId)).toEqual(["res-1"]);
  });
});

describe("outbox", () => {
  it("retries messages that failed for a reason that might clear up", async () => {
    await db.insertOutbox({
      id: "m1",
      chatId: "res-1",
      text: "undelivered",
      delivered: false,
      error: "Telegram HTTP 500",
      retries: 3,
      createdAt: iso(0),
    });
    await db.insertOutbox({
      id: "m2",
      chatId: "res-2",
      text: "blocked chat",
      delivered: false,
      error: "blocked",
      retries: 0,
      createdAt: iso(0),
    });

    const result = await deliverPending(db, n);
    expect(result.sent).toBe(1);
    expect(n.resent.map((m) => m.id)).toEqual(["m1"]);
  });
});
