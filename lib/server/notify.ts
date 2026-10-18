import type { OutboxMessage, Station } from "../schemas";
import { type Db, newId, nowIso } from "./db";

export interface Button {
  text: string;
  data: string;
}

export interface SendResult {
  ok: boolean;
  /** The chat blocked the bot or no longer exists: stop sending to it. */
  blocked?: boolean;
  error?: string;
}

export interface Notifier {
  readonly mode: "telegram" | "log";
  send(chatId: string, text: string, buttons?: Button[][]): Promise<SendResult>;
  /** Retry a message already in the outbox, without creating a second record. */
  resend(m: OutboxMessage): Promise<SendResult>;
  answerCallback(callbackId: string, text: string): Promise<void>;
}

/** Retries left for a message that failed for a reason that might clear up. */
export const OUTBOX_RETRIES = 3;

class TelegramBlocked extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends through the Telegram Bot API; every message is also written to the outbox. */
export class TelegramNotifier implements Notifier {
  readonly mode = "telegram" as const;
  constructor(
    private readonly db: Db,
    private readonly token: string,
  ) {}

  private async call(method: string, body: unknown, retryOn429 = true): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (res.ok && json.ok) return;

    // Telegram throttles broadcasts; it tells us exactly how long to wait.
    const retryAfter = json.parameters?.retry_after;
    if ((res.status === 429 || json.error_code === 429) && retryOn429 && retryAfter != null && retryAfter <= 30) {
      await sleep((retryAfter + 1) * 1000);
      return this.call(method, body, false);
    }
    // 403 = bot blocked or kicked; 400 "chat not found" = the id is gone.
    if (json.error_code === 403 || /chat not found|user is deactivated/i.test(json.description ?? "")) {
      throw new TelegramBlocked(json.description || "chat unreachable");
    }
    throw new Error(json.description || `Telegram HTTP ${res.status}`);
  }

  private payload(chatId: string, text: string, buttons?: Button[][]) {
    return {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: buttons
        ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) }
        : undefined,
    };
  }

  async send(chatId: string, text: string, buttons?: Button[][]): Promise<SendResult> {
    let error: string | null = null;
    let blocked = false;
    try {
      await this.call("sendMessage", this.payload(chatId, text, buttons));
    } catch (e) {
      blocked = e instanceof TelegramBlocked;
      error = e instanceof Error ? e.message : String(e);
      console.error(`[notify] telegram send failed (${blocked ? "blocked" : "error"}): ${error}`);
    }
    await this.db.insertOutbox({
      id: newId(),
      chatId,
      text,
      delivered: !error,
      error,
      // A blocked chat will never work; anything else is worth another try from the job.
      retries: error && !blocked ? OUTBOX_RETRIES : 0,
      createdAt: nowIso(),
    });
    return { ok: !error, blocked, error: error ?? undefined };
  }

  async resend(m: OutboxMessage): Promise<SendResult> {
    try {
      await this.call("sendMessage", this.payload(m.chatId, m.text));
      await this.db.updateOutbox(m.id, { delivered: true, error: null, retries: 0 });
      return { ok: true };
    } catch (e) {
      const blocked = e instanceof TelegramBlocked;
      const error = e instanceof Error ? e.message : String(e);
      await this.db.updateOutbox(m.id, { error, retries: blocked ? 0 : Math.max(0, (m.retries ?? 1) - 1) });
      return { ok: false, blocked, error };
    }
  }

  async answerCallback(callbackId: string, text: string) {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, text }).catch((e) =>
      console.error(`[notify] answerCallbackQuery failed: ${e}`),
    );
  }
}

/** No bot token: print messages and keep them in the outbox so they are visible on the dashboard. */
export class LogNotifier implements Notifier {
  readonly mode = "log" as const;
  constructor(private readonly db: Db) {}

  async send(chatId: string, text: string, buttons?: Button[][]): Promise<SendResult> {
    const btn = buttons ? `\n  [buttons: ${buttons.flat().map((b) => b.text).join(" | ")}]` : "";
    console.log(`[notify → ${chatId}] ${text.replace(/\n/g, "\n  ")}${btn}`);
    await this.db.insertOutbox({
      id: newId(),
      chatId,
      text: text + btn,
      delivered: false,
      error: null,
      retries: 0,
      createdAt: nowIso(),
    });
    return { ok: true };
  }

  async resend() {
    return { ok: true };
  }

  async answerCallback() {}
}

/** Routes "demo-*" chat ids (the /demo page's stand-in recipients) to the log notifier. */
class DemoAwareNotifier implements Notifier {
  readonly mode = "telegram" as const;
  constructor(
    private readonly real: Notifier,
    private readonly log: Notifier,
  ) {}
  send(chatId: string, text: string, buttons?: Button[][]) {
    return (chatId.startsWith("demo-") ? this.log : this.real).send(chatId, text, buttons);
  }
  resend(m: OutboxMessage) {
    return (m.chatId.startsWith("demo-") ? this.log : this.real).resend(m);
  }
  answerCallback(callbackId: string, text: string) {
    return this.real.answerCallback(callbackId, text);
  }
}

export function getNotifier(db: Db): Notifier {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return token ? new DemoAwareNotifier(new TelegramNotifier(db, token), new LogNotifier(db)) : new LogNotifier(db);
}

/**
 * Message every resident subscribed to the station. Returns the number of chats
 * reached. A chat that has blocked the bot is unsubscribed so the next flood
 * does not spend its first minutes retrying dead chats.
 */
export async function broadcastToSubscribers(db: Db, n: Notifier, stationId: string, text: string): Promise<number> {
  const subs = await db.listSubscribers(stationId);
  let sent = 0;
  for (const s of subs) {
    const r = await n.send(s.chatId, text);
    if (r.ok) sent++;
    else if (r.blocked) {
      await db.removeSubscriber(s.chatId, stationId);
      console.warn(`[notify] unsubscribed a chat that blocked the bot (${stationId})`);
    }
  }
  return sent;
}

/** Message the station's observer team. */
export async function notifyTeam(n: Notifier, station: Station, text: string, buttons?: Button[][]): Promise<number> {
  let sent = 0;
  for (const chatId of station.teamChatIds) if ((await n.send(chatId, text, buttons)).ok) sent++;
  return sent;
}

/** Try undelivered messages again. Called by the background job. */
export async function deliverPending(db: Db, n: Notifier, limit = 50): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const m of await db.listOutboxPending(limit)) {
    const r = await n.resend(m);
    if (r.ok) sent++;
    else failed++;
  }
  return { sent, failed };
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

export function dashboardUrl(stationId: string): string | null {
  const base = process.env.PUBLIC_BASE_URL;
  return base ? `${base.replace(/\/$/, "")}/dashboard?station=${encodeURIComponent(stationId)}` : null;
}
