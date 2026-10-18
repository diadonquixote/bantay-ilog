import { DEFAULT_STATION } from "../lib/levels";
import { FileDb, newId } from "../lib/server/db";
import type { Button, Notifier, SendResult } from "../lib/server/notify";
import type { OutboxMessage, Reading, Station } from "../lib/schemas";

export class FakeNotifier implements Notifier {
  readonly mode = "log" as const;
  sent: { chatId: string; text: string; buttons?: Button[][] }[] = [];
  resent: OutboxMessage[] = [];
  /** Chats that behave as if they blocked the bot. */
  blocked = new Set<string>();

  async send(chatId: string, text: string, buttons?: Button[][]): Promise<SendResult> {
    if (this.blocked.has(chatId)) return { ok: false, blocked: true, error: "blocked" };
    this.sent.push({ chatId, text, buttons });
    return { ok: true };
  }
  async resend(m: OutboxMessage): Promise<SendResult> {
    this.resent.push(m);
    return { ok: true };
  }
  async answerCallback() {}
}

export const testStation: Station = { ...DEFAULT_STATION, teamChatIds: ["team-1"], hotline: "MDRRMO 0999", evacuationCenter: "Barangay Hall" };

/** Pipeline calls use the real clock, so anchor test time to "now". */
export const T0 = Math.floor(Date.now() / 60_000) * 60_000;
export const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

export function reading(
  level: number,
  opts: { min?: number; status?: Reading["status"]; stationId?: string } = {},
): Reading {
  const min = opts.min ?? 0;
  const status = opts.status ?? "accepted";
  return {
    id: newId(),
    stationId: opts.stationId ?? testStation.id,
    clientId: null,
    takenAt: iso(min),
    createdAt: iso(min),
    source: "photo",
    aiLevel: level,
    aiConfidence: 0.9,
    aiNotes: null,
    observerLevel: level,
    observerName: "obs",
    observerKey: "name:obs",
    level: status === "accepted" ? level : null,
    status,
    statusReason: "test",
    photoPath: null,
    photoHash: null,
    confirmedBy: null,
    confirmedByKey: null,
  };
}

export async function freshDb(station: Station = testStation): Promise<FileDb> {
  const db = new FileDb(null);
  await db.upsertStation(station);
  return db;
}
