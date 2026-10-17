import { timingSafeEqual } from "node:crypto";
import { formatLevel, LEVELS } from "@/lib/levels";
import type { Station } from "@/lib/schemas";
import { type Db, getDb, newId, nowIso } from "@/lib/server/db";
import { formatTime, getNotifier, type Notifier } from "@/lib/server/notify";
import { ConfirmError, confirmReading, ingestReading } from "@/lib/server/pipeline";
import { getStationStatus } from "@/lib/server/status";
import { describeTrend } from "@/lib/server/trend";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface TgUpdate {
  message?: { chat: { id: number }; from?: { first_name?: string; username?: string }; text?: string };
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string; username?: string };
    message?: { chat: { id: number } };
    data?: string;
  };
}

const HELP = [
  "Bantay Ilog — babala sa lebel ng ilog / river level alerts",
  "",
  "/subscribe <istasyon> — tumanggap ng babala / get alerts",
  "/status — kasalukuyang lebel ng ilog / current river level",
  "/stop — itigil ang babala / stop alerts",
  "/stations — listahan ng istasyon / list stations",
].join("\n");

const TEAM_HELP = [
  "",
  "Para sa observer team / For the observer team:",
  "/reading <station> <metres> — report a reading without a photo (needs a second person to confirm)",
  "/myid — your chat ID",
].join("\n");

const OBSERVER_HINT = "\n\nVolunteer observer? Send /myid and give the number to your coordinator.";

function secretOk(req: Request): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;
  const got = Buffer.from(req.headers.get("x-telegram-bot-api-secret-token") ?? "");
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function statusText(db: Db, station: Station): Promise<string> {
  const s = await getStationStatus(db, station);
  const p = s.pendingHighest;
  const pendingLine =
    p && p.stage !== "normal" && (!s.latest || Date.parse(p.takenAt) > Date.parse(s.latest.takenAt))
      ? `\n⏳ May bagong ulat na ${formatLevel(p.level)} (${formatTime(p.takenAt)}) na sinusuri pa.\n` +
        `A newer report of ${formatLevel(p.level)} is being checked. You will get an alert if it is confirmed.`
      : "";
  if (!s.latest || !s.stage) {
    return `${station.name}: wala pang kumpirmadong sukat / no confirmed reading yet.${pendingLine}`;
  }
  const info = LEVELS[s.stage];
  return (
    `${station.name} (${station.river})\n` +
    `${formatLevel(s.latest.level)} — ${formatTime(s.latest.takenAt)}\n` +
    `${info.labelTl} / ${info.label}\n` +
    `Trend: ${describeTrend(s.trend)}${pendingLine}`
  );
}

async function handleMessage(db: Db, n: Notifier, chatId: string, who: string, text: string) {
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, "");
  const all = await db.listStations();
  // The demo station is for the /demo page only; residents never see it.
  const stations = all.filter((s) => s.id !== "demo");
  const find = (id?: string) => stations.find((s) => s.id === id?.toLowerCase());
  const isTeam = all.some((s) => s.teamChatIds.includes(chatId));
  const help = isTeam ? HELP + TEAM_HELP : HELP + OBSERVER_HINT;

  switch (cmd) {
    case "/start":
    case "/subscribe": {
      const st = find(args[0]);
      if (!st) {
        const list = stations.map((s) => `/subscribe ${s.id} — ${s.name} (${s.river})`).join("\n");
        return n.send(chatId, `${cmd === "/start" ? `${help}\n\n` : ""}Pumili ng istasyon / Choose a station:\n${list}`);
      }
      await db.addSubscriber({ chatId, stationId: st.id, name: who, createdAt: nowIso() });
      return n.send(
        chatId,
        `✅ Naka-subscribe ka na sa ${st.name}. Makakatanggap ka ng babala kapag tumaas ang ilog.\n` +
          `You are subscribed to ${st.name}. You'll get alerts when the river rises.\n\n${await statusText(db, st)}`,
      );
    }
    case "/stop": {
      const removed = await db.removeSubscriber(chatId, find(args[0])?.id);
      return n.send(chatId, removed ? "Alerts stopped. / Itinigil na ang mga babala." : "You had no subscriptions.");
    }
    case "/status": {
      const targets = args[0]
        ? [find(args[0])].filter((s): s is Station => !!s)
        : (await db.listSubscriptions(chatId)).map((sub) => find(sub.stationId)).filter((s): s is Station => !!s);
      if (!targets.length) return n.send(chatId, "Hindi ka pa naka-subscribe. / You are not subscribed yet.\nGamitin / Use: /status <station>  (tingnan / see /stations)");
      return n.send(chatId, (await Promise.all(targets.map((s) => statusText(db, s)))).join("\n\n"));
    }
    case "/stations":
      return n.send(chatId, stations.map((s) => `${s.id} — ${s.name} (${s.river})`).join("\n"));
    case "/myid":
      return n.send(chatId, `Your chat ID: ${chatId}`);
    case "/reading": {
      const st = find(args[0]);
      const level = Number(args[1]);
      if (!st || !Number.isFinite(level)) return n.send(chatId, "Usage: /reading <station> <level in metres>, e.g. /reading sto-nino 15.4");
      if (!st.teamChatIds.includes(chatId)) return n.send(chatId, "Only the observer team for this station can send readings.");
      const res = await ingestReading(db, n, {
        station: st,
        source: "telegram",
        ai: null,
        observerLevel: level,
        observerName: `tg:${chatId}`,
      });
      return n.send(chatId, `Received ${level.toFixed(2)} m for ${st.name}. Status: ${res.reading.status.replace("_", " ")} — ${res.reading.statusReason}`);
    }
    default:
      return n.send(chatId, help);
  }
}

async function handleCallback(db: Db, n: Notifier, cb: NonNullable<TgUpdate["callback_query"]>) {
  const chatId = String(cb.message?.chat.id ?? cb.from.id);
  const [kind, readingId, levelStr] = (cb.data ?? "").split(":");
  const reading = readingId ? await db.getReading(readingId) : null;
  const station = reading ? await db.getStation(reading.stationId) : null;
  if (!reading || !station) return n.answerCallback(cb.id, "Reading not found.");
  if (!station.teamChatIds.includes(String(cb.from.id)) && !station.teamChatIds.includes(chatId)) {
    return n.answerCallback(cb.id, "Only the observer team can confirm readings.");
  }
  try {
    const { reading: r, outcome } = await confirmReading(db, n, {
      readingId,
      action: kind === "x" ? "reject" : "accept",
      level: kind === "c" ? Number(levelStr) : undefined,
      confirmedBy: `tg:${cb.from.id}`,
    });
    await n.answerCallback(cb.id, r.status === "accepted" ? `Accepted ${formatLevel(r.level)}` : "Rejected");
    const alertNote = outcome?.alerts.length ? ` ${outcome.alerts.length} alert(s) sent to residents.` : "";
    await n.send(chatId, `${station.name}: reading ${r.status} by ${cb.from.first_name ?? "team"}.${alertNote}`);
  } catch (e) {
    if (e instanceof ConfirmError) return n.answerCallback(cb.id, e.message);
    throw e;
  }
}

export async function POST(req: Request) {
  if (!secretOk(req)) return new Response("forbidden", { status: 403 });
  const update = (await req.json().catch(() => null)) as TgUpdate | null;
  if (!update || typeof update !== "object" || Array.isArray(update)) return new Response("bad request", { status: 400 });

  const db = getDb();
  const n = getNotifier(db);
  try {
    if (update.callback_query) {
      await handleCallback(db, n, update.callback_query);
    } else if (update.message?.text) {
      const m = update.message;
      const who = m.from?.username ? `@${m.from.username}` : (m.from?.first_name ?? null);
      await handleMessage(db, n, String(m.chat.id), who ?? "", m.text!);
    }
  } catch (e) {
    // Always 200 so Telegram doesn't retry the same update forever.
    console.error(`[telegram] update failed (${newId()})`, e);
  }
  return Response.json({ ok: true });
}
