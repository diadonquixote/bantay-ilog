import type Anthropic from "@anthropic-ai/sdk";
import { LEVEL_KEYS, type Alert, type LevelKey, type Station } from "../schemas";
import { LEVELS } from "../levels";
import { type Db, newId } from "./db";
import { broadcastToSubscribers, formatTime, type Notifier, notifyTeam } from "./notify";
import { scheduleReminder } from "./reminders";
import { getStationStatus } from "./status";
import { describeTrend } from "./trend";

export interface ToolContext {
  db: Db;
  notifier: Notifier;
  station: Station;
  readingId: string | null;
  now: Date;
  /** Alerts sent during this agent run. */
  sent: Alert[];
}

/** Minimum gap between two alerts at the same stage. */
export const DUPLICATE_WINDOW_MIN: Record<LevelKey, number> = { normal: 120, alert: 60, alarm: 30, critical: 15 };

type ToolDef = Anthropic.Beta.BetaTool;

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "get_station_status",
    description:
      "Current state of the station: thresholds, latest confirmed level, flood stage, trend (m/h, direction, projected minutes to next threshold), pending unconfirmed readings and the last alert sent.",
    input_schema: obj({}),
    strict: true,
  },
  {
    name: "get_recent_readings",
    description: "Confirmed readings at this station over the last N hours, newest first (max 50).",
    input_schema: obj({ hours: { type: "number", description: "How far back to look, 1–48." } }),
    strict: true,
  },
  {
    name: "get_alert_history",
    description: "Alerts already sent to residents of this station in the last N hours, newest first.",
    input_schema: obj({ hours: { type: "number", description: "How far back to look, 1–72." } }),
    strict: true,
  },
  {
    name: "get_pagasa_advisory",
    description: "Latest PAGASA rainfall warning on record (none/yellow/orange/red/unknown) and how old it is.",
    input_schema: obj({}),
    strict: true,
  },
  {
    name: "send_alert",
    description:
      "Send a flood alert to every resident subscribed to this station and to the observer team. `level` must equal the station's current stage. Rejected if an alert at the same stage went out recently.",
    input_schema: obj({
      level: { type: "string", enum: [...LEVEL_KEYS] },
      message: { type: "string", description: "Tagalog then English, plain language, under 900 characters." },
    }),
    strict: true,
  },
  {
    name: "schedule_reading_reminder",
    description: "Ask the observer team to take another gauge reading in N minutes (5–240).",
    input_schema: obj({
      minutes_from_now: { type: "integer" },
      reason: { type: "string" },
    }),
    strict: true,
  },
];

export class ToolError extends Error {}

const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : dflt;
  return Math.min(hi, Math.max(lo, v));
};

export async function sendAlertChecked(
  ctx: ToolContext,
  level: LevelKey,
  message: string,
  origin: Alert["origin"],
): Promise<Alert> {
  const status = await getStationStatus(ctx.db, ctx.station, ctx.now);
  if (!status.stage) throw new ToolError("No confirmed reading yet; nothing to alert on.");
  if (level !== status.stage) {
    throw new ToolError(`level must be the current stage "${status.stage}", got "${level}".`);
  }
  const trimmed = message.trim();
  if (trimmed.length < 20 || trimmed.length > 900) throw new ToolError("message must be 20–900 characters.");

  const windowMin = DUPLICATE_WINDOW_MIN[level];
  const recent = await ctx.db.listAlerts(ctx.station.id, new Date(ctx.now.getTime() - windowMin * 60_000).toISOString());
  const dup = recent.find((a) => a.level === level);
  if (dup) {
    throw new ToolError(
      `An alert at stage "${level}" was already sent at ${formatTime(dup.createdAt)}; repeats at this stage are allowed after ${windowMin} min.`,
    );
  }

  const residents = await broadcastToSubscribers(ctx.db, ctx.notifier, ctx.station.id, trimmed);
  const team = await notifyTeam(ctx.notifier, ctx.station, `[sent to residents]\n${trimmed}`);
  const alert: Alert = {
    id: newId(),
    stationId: ctx.station.id,
    readingId: ctx.readingId,
    level,
    message: trimmed,
    origin,
    recipients: residents + team,
    createdAt: ctx.now.toISOString(),
  };
  await ctx.db.insertAlert(alert);
  ctx.sent.push(alert);
  return alert;
}

/** Execute one tool call. Returns a JSON-serialisable result; throws ToolError for model-correctable mistakes. */
export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const { db, station, now } = ctx;
  switch (name) {
    case "get_station_status": {
      const s = await getStationStatus(db, station, now);
      return {
        station: { id: station.id, name: station.name, river: station.river, thresholds_m: station.thresholds },
        now: formatTime(now.toISOString()),
        latest: s.latest ? { level_m: s.latest.level, taken_at: formatTime(s.latest.takenAt) } : null,
        stage: s.stage,
        stage_label: s.stage ? LEVELS[s.stage].label : null,
        previous_stage: s.previousStage,
        trend: {
          summary: describeTrend(s.trend),
          rate_m_per_hour: s.trend.ratePerHour,
          direction: s.trend.direction,
          next_threshold: s.trend.eta,
        },
        pending_unconfirmed_readings: s.pendingConfirmations,
        last_alert: s.lastAlert
          ? { level: s.lastAlert.level, sent_at: formatTime(s.lastAlert.createdAt), message: s.lastAlert.message }
          : null,
      };
    }
    case "get_recent_readings": {
      const hours = clamp(input.hours, 1, 48, 6);
      const rows = await db.listReadings(station.id, {
        status: "accepted",
        sinceIso: new Date(now.getTime() - hours * 3_600_000).toISOString(),
        limit: 50,
      });
      return rows.map((r) => ({ level_m: r.level, taken_at: formatTime(r.takenAt), source: r.source }));
    }
    case "get_alert_history": {
      const hours = clamp(input.hours, 1, 72, 12);
      const rows = await db.listAlerts(station.id, new Date(now.getTime() - hours * 3_600_000).toISOString());
      return rows.map((a) => ({ level: a.level, sent_at: formatTime(a.createdAt), message: a.message }));
    }
    case "get_pagasa_advisory": {
      const a = await db.latestAdvisory();
      if (!a) return { warning: "unknown", text: "No PAGASA advisory on record." };
      return {
        warning: a.warning,
        text: a.text.slice(0, 1500),
        fetched: formatTime(a.fetchedAt),
        age_minutes: Math.round((now.getTime() - Date.parse(a.fetchedAt)) / 60_000),
      };
    }
    case "send_alert": {
      const level = input.level as LevelKey;
      if (!LEVEL_KEYS.includes(level)) throw new ToolError(`Unknown level "${String(input.level)}".`);
      const alert = await sendAlertChecked(ctx, level, String(input.message ?? ""), "agent");
      return { sent: true, recipients: alert.recipients, alert_id: alert.id };
    }
    case "schedule_reading_reminder": {
      const minutes = Math.round(clamp(input.minutes_from_now, 5, 240, 30));
      const r = await scheduleReminder(db, station.id, minutes, String(input.reason ?? "requested by alert agent"), now);
      return { scheduled: true, due_at: formatTime(r.dueAt) };
    }
    default:
      throw new ToolError(`Unknown tool "${name}".`);
  }
}
