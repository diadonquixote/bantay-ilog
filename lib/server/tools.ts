import type Anthropic from "@anthropic-ai/sdk";
import { ALERT_KINDS, LEVEL_KEYS, type Alert, type AlertKind, type LevelKey, type Station } from "../schemas";
import { LEVELS, rankOf } from "../levels";
import { DuplicateAlertError, type Db, newId } from "./db";
import { alertMessage, messageFits } from "./messages";
import { broadcastToSubscribers, formatTime, type Notifier, notifyTeam } from "./notify";
import { scheduleReminder } from "./reminders";
import { getStationStatus, isStale, type StationStatus } from "./status";
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
/** Kinds that repeat on their own schedule rather than the stage's. */
export const KIND_WINDOW_MIN: Partial<Record<AlertKind, number>> = {
  provisional: 30,
  "de-escalation": 60,
  "all-clear": 120,
};

export const windowMinutes = (kind: AlertKind, level: LevelKey): number =>
  KIND_WINDOW_MIN[kind] ?? DUPLICATE_WINDOW_MIN[level];

/**
 * An early warning waits this long after *any* message to residents.
 *
 * Without it, a river that crosses a threshold and keeps rising sends a stage
 * alert and then, minutes later, "may reach the next stage" — two notifications
 * back to back, which is how people learn to swipe alerts away.
 */
export const EARLY_QUIET_MIN = 30;

/** Kinds the model may ask for. "provisional" is automatic and not the agent's to send. */
export const AGENT_ALERT_KINDS: AlertKind[] = ["stage", "early", "de-escalation", "all-clear"];

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
      "Current state of the station: thresholds, latest confirmed level and how old it is, flood stage, trend (m/h, direction, projected minutes to next threshold), pending unconfirmed readings and the last alert sent.",
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
    description:
      "Latest PAGASA rainfall warning on record (none/yellow/orange/red/unknown) and how old it is. Background only: it never changes the stage you may alert at.",
    input_schema: obj({}),
    strict: true,
  },
  {
    name: "preview_alert",
    description:
      "See the exact message residents would receive for a given kind, without sending it. Use it to check what they have already been told.",
    input_schema: obj({ kind: { type: "string", enum: [...AGENT_ALERT_KINDS] } }),
    strict: true,
  },
  {
    name: "send_alert",
    description:
      "Send a flood alert to every resident subscribed to this station and to the observer team. You choose whether and when; the wording comes from a reviewed bilingual template. `level` must equal the station's current stage. Rejected if an equivalent alert went out recently.",
    input_schema: obj({
      level: { type: "string", enum: [...LEVEL_KEYS] },
      kind: {
        type: "string",
        enum: [...AGENT_ALERT_KINDS],
        description:
          "stage = the river reached this stage; early = rising and expected to cross the next threshold soon; de-escalation = fell to a lower but still dangerous stage; all-clear = back to normal.",
      },
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

export interface SendAlertArgs {
  level: LevelKey;
  kind: AlertKind;
  origin: Alert["origin"];
  /** Pre-fetched status, so a caller that already has one does not query twice. */
  status?: StationStatus;
  /** Required for a provisional warning: the unconfirmed reading behind it. */
  pending?: { level: number; stage: LevelKey } | null;
  /** The stage residents were last told about, for a de-escalation. */
  from?: LevelKey | null;
}

/** Render the message a given alert would carry, without sending anything. */
export function renderAlert(s: StationStatus, args: Pick<SendAlertArgs, "kind" | "level" | "pending" | "from">): string {
  return alertMessage(args.kind, {
    station: s.station,
    level: s.latest?.level ?? null,
    ratePerHour: s.trend.ratePerHour,
    takenAt: s.latest?.takenAt ?? null,
    stage: args.level,
    eta: s.trend.eta,
    pending: args.pending ?? null,
    from: args.from ?? s.lastAlert?.level ?? null,
  });
}

/**
 * The only way an alert reaches residents.
 *
 * Guardrails, in order: the stage must match what the gauge actually says, the
 * text comes from a template, and the database refuses a second alert of the
 * same kind and stage inside its repeat window — so two requests racing each
 * other cannot both get through.
 */
export async function sendAlertChecked(ctx: ToolContext, args: SendAlertArgs): Promise<Alert> {
  const status = args.status ?? (await getStationStatus(ctx.db, ctx.station, ctx.now));
  const { kind, level } = args;

  if (kind === "provisional") {
    if (!args.pending) throw new ToolError("A provisional warning needs the unconfirmed reading it is based on.");
    if (rankOf(level) === 0) throw new ToolError("A provisional warning is only for an elevated stage.");
  } else {
    if (!status.stage) throw new ToolError("No confirmed reading yet; nothing to alert on.");
    if (level !== status.stage) {
      throw new ToolError(`level must be the current stage "${status.stage}", got "${level}".`);
    }
    if (isStale(status)) {
      throw new ToolError(
        `The latest confirmed reading is ${status.ageMinutes} min old; ask for a fresh reading before alerting residents.`,
      );
    }
  }
  if (kind === "early") {
    if (!status.trend.eta) {
      throw new ToolError("An early warning needs a projected crossing time, and the trend has none.");
    }
    const since = new Date(ctx.now.getTime() - EARLY_QUIET_MIN * 60_000).toISOString();
    const [recent] = await ctx.db.listAlerts(ctx.station.id, since);
    if (recent) {
      throw new ToolError(
        `Residents were already messaged at ${formatTime(recent.createdAt)}; an early warning waits ${EARLY_QUIET_MIN} min after any alert.`,
      );
    }
  }

  const message = renderAlert(status, args);
  if (!messageFits(message)) throw new ToolError("Rendered message was out of bounds; alert not sent.");

  const windowMin = windowMinutes(kind, level);
  const recent = await ctx.db.listAlerts(ctx.station.id, new Date(ctx.now.getTime() - windowMin * 60_000).toISOString());
  const dup = recent.find((a) => a.level === level && a.kind === kind);
  if (dup) {
    throw new ToolError(
      `A "${kind}" alert at stage "${level}" was already sent at ${formatTime(dup.createdAt)}; repeats are allowed after ${windowMin} min.`,
    );
  }

  const bucket = Math.floor(ctx.now.getTime() / (windowMin * 60_000));
  const alert: Alert = {
    id: newId(),
    stationId: ctx.station.id,
    readingId: ctx.readingId,
    level,
    kind,
    message,
    origin: args.origin,
    recipients: 0,
    dedupeKey: `${ctx.station.id}|${kind}|${level}|${bucket}`,
    createdAt: ctx.now.toISOString(),
  };

  // Claim the slot before sending: if another request already holds it, stop here.
  try {
    await ctx.db.insertAlert(alert);
  } catch (e) {
    if (e instanceof DuplicateAlertError) {
      throw new ToolError(`An identical "${kind}" alert at stage "${level}" is already going out.`);
    }
    throw e;
  }

  const residents = await broadcastToSubscribers(ctx.db, ctx.notifier, ctx.station.id, message);
  const team = await notifyTeam(ctx.notifier, ctx.station, `[sent to residents]\n${message}`);
  const recipients = residents + team;
  await ctx.db.updateAlertRecipients(alert.id, recipients);
  const saved = { ...alert, recipients };
  ctx.sent.push(saved);
  return saved;
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
        latest: s.latest
          ? { level_m: s.latest.level, taken_at: formatTime(s.latest.takenAt), age_minutes: s.ageMinutes }
          : null,
        reading_is_stale: isStale(s),
        stage: s.stage,
        stage_label: s.stage ? LEVELS[s.stage].label : null,
        previous_stage: s.previousStage,
        readings_in_a_row_at_this_stage: s.stageRun,
        trend: {
          summary: describeTrend(s.trend),
          rate_m_per_hour: s.trend.ratePerHour,
          direction: s.trend.direction,
          next_threshold: s.trend.eta,
        },
        pending_unconfirmed_readings: s.pendingConfirmations,
        highest_unconfirmed: s.pendingHighest
          ? { level_m: s.pendingHighest.level, stage: s.pendingHighest.stage, taken_at: formatTime(s.pendingHighest.takenAt) }
          : null,
        last_alert: s.lastAlert
          ? { level: s.lastAlert.level, kind: s.lastAlert.kind, sent_at: formatTime(s.lastAlert.createdAt) }
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
      return rows.map((a) => ({
        level: a.level,
        kind: a.kind,
        sent_at: formatTime(a.createdAt),
        recipients: a.recipients,
        message: a.message,
      }));
    }
    case "get_pagasa_advisory": {
      const a = await db.latestAdvisory();
      if (!a) return { warning: "unknown", text: "No PAGASA advisory on record." };
      return {
        warning: a.warning,
        // Background only, and never quoted to residents.
        text: a.text.slice(0, 1500),
        fetched: formatTime(a.fetchedAt),
        age_minutes: Math.round((now.getTime() - Date.parse(a.fetchedAt)) / 60_000),
      };
    }
    case "preview_alert": {
      const kind = String(input.kind) as AlertKind;
      if (!AGENT_ALERT_KINDS.includes(kind)) throw new ToolError(`Unknown alert kind "${kind}".`);
      const s = await getStationStatus(db, station, now);
      if (!s.stage) throw new ToolError("No confirmed reading yet.");
      return { kind, level: s.stage, message: renderAlert(s, { kind, level: s.stage }) };
    }
    case "send_alert": {
      const level = input.level as LevelKey;
      const kind = input.kind as AlertKind;
      if (!LEVEL_KEYS.includes(level)) throw new ToolError(`Unknown level "${String(input.level)}".`);
      if (!ALERT_KINDS.includes(kind) || !AGENT_ALERT_KINDS.includes(kind)) {
        throw new ToolError(`Unknown or not-allowed alert kind "${String(input.kind)}".`);
      }
      const alert = await sendAlertChecked(ctx, { level, kind, origin: "agent" });
      return { sent: true, recipients: alert.recipients, alert_id: alert.id, message: alert.message };
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
