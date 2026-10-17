import type { Station } from "../schemas";
import { type Db, newId, nowIso } from "./db";

export interface Button {
  text: string;
  data: string;
}

export interface Notifier {
  readonly mode: "telegram" | "log";
  send(chatId: string, text: string, buttons?: Button[][]): Promise<boolean>;
  answerCallback(callbackId: string, text: string): Promise<void>;
}

/** Sends through the Telegram Bot API; every message is also written to the outbox. */
export class TelegramNotifier implements Notifier {
  readonly mode = "telegram" as const;
  constructor(
    private readonly db: Db,
    private readonly token: string,
  ) {}

  private async call(method: string, body: unknown) {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || !json.ok) throw new Error(json.description || `Telegram HTTP ${res.status}`);
  }

  async send(chatId: string, text: string, buttons?: Button[][]) {
    let error: string | null = null;
    try {
      await this.call("sendMessage", {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        reply_markup: buttons
          ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) }
          : undefined,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error(`[notify] telegram send to ${chatId} failed: ${error}`);
    }
    await this.db.insertOutbox({ id: newId(), chatId, text, delivered: !error, error, createdAt: nowIso() });
    return !error;
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

  async send(chatId: string, text: string, buttons?: Button[][]) {
    const btn = buttons ? `\n  [buttons: ${buttons.flat().map((b) => b.text).join(" | ")}]` : "";
    console.log(`[notify → ${chatId}] ${text.replace(/\n/g, "\n  ")}${btn}`);
    await this.db.insertOutbox({ id: newId(), chatId, text: text + btn, delivered: false, error: null, createdAt: nowIso() });
    return true;
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
  answerCallback(callbackId: string, text: string) {
    return this.real.answerCallback(callbackId, text);
  }
}

export function getNotifier(db: Db): Notifier {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return token ? new DemoAwareNotifier(new TelegramNotifier(db, token), new LogNotifier(db)) : new LogNotifier(db);
}

/** Message every resident subscribed to the station. Returns the number of chats reached. */
export async function broadcastToSubscribers(db: Db, n: Notifier, stationId: string, text: string): Promise<number> {
  const subs = await db.listSubscribers(stationId);
  let sent = 0;
  for (const s of subs) if (await n.send(s.chatId, text)) sent++;
  return sent;
}

/** Message the station's observer team. */
export async function notifyTeam(n: Notifier, station: Station, text: string, buttons?: Button[][]): Promise<number> {
  let sent = 0;
  for (const chatId of station.teamChatIds) if (await n.send(chatId, text, buttons)) sent++;
  return sent;
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
