import type Anthropic from "@anthropic-ai/sdk";
import { LEVELS, rankOf } from "../levels";
import type { Alert, LevelKey } from "../schemas";
import { aiMode, describeAiError, FALLBACK_BETA, getAnthropic, loadPrompt, MODEL } from "./ai";
import { formatTime } from "./notify";
import { getStationStatus, type StationStatus } from "./status";
import { executeTool, sendAlertChecked, TOOL_DEFS, type ToolContext, ToolError } from "./tools";

export interface AgentStep {
  tool: string;
  input: unknown;
  result: unknown;
  isError: boolean;
}

export interface AgentOutcome {
  mode: "agent" | "rule" | "skipped";
  summary: string;
  steps: AgentStep[];
  alerts: Alert[];
  /** Alerts sent by the deterministic safety net after the agent ran. */
  safetyNet: Alert[];
}

const MAX_TURNS = 8;

/** Should a new accepted reading wake the alert agent at all? Keeps calm days free of model calls. */
export function shouldConsult(s: StationStatus, advisoryWarning: string | null): string | null {
  if (!s.stage) return null;
  if (s.previousStage && s.stage !== s.previousStage) return `stage changed ${s.previousStage} → ${s.stage}`;
  if (rankOf(s.stage) > 0) return `river is at ${s.stage} stage`;
  if (s.trend.direction === "rising" && s.trend.eta && s.trend.eta.minutes <= 120) {
    return `rising, ${s.trend.eta.key} threshold in ~${s.trend.eta.minutes} min`;
  }
  if (s.lastAlert && rankOf(s.lastAlert.level) > 0) return "back to normal after an alert";
  if ((advisoryWarning === "orange" || advisoryWarning === "red") && s.trend.direction === "rising") {
    return `PAGASA ${advisoryWarning} warning and river rising`;
  }
  return null;
}

/** Deterministic bilingual alert text, used by rule mode and the safety net. */
export function ruleMessage(s: StationStatus, kind: "stage" | "early" | "all-clear"): string {
  const st = s.station;
  const info = LEVELS[s.stage!];
  const level = s.latest?.level?.toFixed(2) ?? "?";
  const rate =
    s.trend.ratePerHour != null ? ` (${s.trend.ratePerHour >= 0 ? "+" : ""}${s.trend.ratePerHour.toFixed(2)} m/h)` : "";
  const when = s.latest ? formatTime(s.latest.takenAt) : "";
  const title = `${st.name} — ${st.river}`;

  if (kind === "early" && s.trend.eta) {
    // Early warning: lead with what is coming, not with the current (possibly "Normal") stage.
    const next = LEVELS[s.trend.eta.key];
    const { value, minutes } = s.trend.eta;
    return (
      `${rankOf(next.key) >= 3 ? "🚨" : "⚠️"} ${title}
` +
      `Tumataas ang ilog: ${level} m${rate}, ${when}. Maaaring umabot sa ${next.labelTl} (${value} m) sa loob ng ~${minutes} minuto. ${next.prepareTl}
` +
      `River rising: ${level} m${rate}. May reach ${next.label} (${value} m) in ~${minutes} min. ${next.prepare}`
    );
  }
  if (kind === "all-clear") {
    return (
      `✅ ${title}
` +
      `Bumaba na ang ilog: ${level} m${rate}, ${when}. Normal na ang lebel. Patuloy na magbantay sa mga anunsyo.
` +
      `River back to normal: ${level} m${rate}. Keep listening for announcements.`
    );
  }
  return (
    `${rankOf(s.stage!) >= 2 ? "🚨" : "⚠️"} ${title}
` +
    `${info.labelTl}: ${level} m${rate}, ${when}.
${info.actionTl}
` +
    `${info.label}: ${level} m${rate}. ${info.action}`
  );
}

/** Returns null if sent, or the reason it was held back (e.g. a recent duplicate). */
async function trySend(ctx: ToolContext, level: LevelKey, msg: string, steps: AgentStep[]): Promise<string | null> {
  try {
    await sendAlertChecked(ctx, level, msg, "rule");
    steps.push({ tool: "send_alert", input: { level }, result: "sent", isError: false });
    return null;
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    steps.push({ tool: "send_alert", input: { level }, result: e.message, isError: true });
    return e.message;
  }
}

const sentOr = (held: string | null, what: string) => (held ? `${what} held back: ${held}` : `sent ${what}.`);

/** The no-AI policy: stage escalations, early warnings and all-clears. */
async function runRules(ctx: ToolContext, s: StationStatus): Promise<AgentOutcome> {
  const steps: AgentStep[] = [];
  const stage = s.stage!;
  let summary: string;

  if (isEscalation(s)) {
    summary = `Stage ${stage}: ${sentOr(await trySend(ctx, stage, ruleMessage(s, "stage"), steps), "stage alert")}`;
  } else if (s.trend.direction === "rising" && s.trend.eta && s.trend.eta.minutes <= 120) {
    const eta = s.trend.eta;
    summary = `Rising toward ${eta.key} in ~${eta.minutes} min: ${sentOr(await trySend(ctx, stage, ruleMessage(s, "early"), steps), "early warning")}`;
  } else if (stage === "normal" && s.lastAlert && rankOf(s.lastAlert.level) > 0) {
    summary = `Back to normal: ${sentOr(await trySend(ctx, stage, ruleMessage(s, "all-clear"), steps), "all-clear")}`;
  } else {
    summary = `Stage ${stage}, no new information for residents; no alert.`;
  }
  return { mode: "rule", summary, steps, alerts: [...ctx.sent], safetyNet: [] };
}

async function runClaude(ctx: ToolContext, trigger: string): Promise<AgentOutcome> {
  const client = getAnthropic();
  const steps: AgentStep[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content:
        `New confirmed reading at station "${ctx.station.name}" (id ${ctx.station.id}). ` +
        `Why you were called: ${trigger}. Decide whether residents need an alert now.`,
    },
  ];
  let summary = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: loadPrompt("alert-agent"),
      tools: TOOL_DEFS,
      messages,
    });

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) summary = text;

    if (response.stop_reason === "refusal") throw new Error("model declined");
    if (response.stop_reason !== "tool_use" && response.stop_reason !== "pause_turn") break;

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      try {
        const result = await executeTool(block.name, input, ctx);
        steps.push({ tool: block.name, input, result, isError: false });
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        steps.push({ tool: block.name, input, result: e.message, isError: true });
        results.push({ type: "tool_result", tool_use_id: block.id, content: e.message, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  return { mode: "agent", summary: summary || "Agent finished without a summary.", steps, alerts: [...ctx.sent], safetyNet: [] };
}

/**
 * Safety net: whatever the agent decided, a rise into a higher flood stage
 * must reach residents. If no alert at the current stage went out (now or
 * within the duplicate window), send the deterministic one.
 */
async function safetyNet(ctx: ToolContext, s: StationStatus): Promise<Alert[]> {
  if (!s.stage || !isEscalation(s) || ctx.sent.some((a) => a.level === s.stage)) return [];
  const before = ctx.sent.length;
  // sendAlertChecked still refuses a duplicate inside the stage's repeat window.
  await trySend(ctx, s.stage, ruleMessage(s, "stage"), []);
  return ctx.sent.slice(before);
}

/** The river is above normal and higher than the last reading's stage or the last alert's stage. */
export function isEscalation(s: StationStatus): boolean {
  if (!s.stage || rankOf(s.stage) === 0) return false;
  const r = rankOf(s.stage);
  return (
    !s.lastAlert ||
    r > rankOf(s.lastAlert.level) ||
    (s.previousStage != null && r > rankOf(s.previousStage))
  );
}

export async function runAlertAgent(ctx: ToolContext, opts: { force?: boolean } = {}): Promise<AgentOutcome> {
  const status = await getStationStatus(ctx.db, ctx.station, ctx.now);
  const advisory = await ctx.db.latestAdvisory();
  const trigger = shouldConsult(status, advisory?.warning ?? null) ?? (opts.force ? "manual run" : null);
  if (!trigger) {
    return { mode: "skipped", summary: "Normal and steady; alert agent not consulted.", steps: [], alerts: [], safetyNet: [] };
  }

  let outcome: AgentOutcome;
  if (aiMode() === "live") {
    try {
      outcome = await runClaude(ctx, trigger);
    } catch (e) {
      console.error(`[alertAgent] Claude agent failed, using rules: ${describeAiError(e)}`);
      outcome = await runRules(ctx, status);
      outcome.summary = `Agent unavailable (${describeAiError(e)}); rules: ${outcome.summary}`;
    }
  } else {
    outcome = await runRules(ctx, status);
  }

  // Judge escalation against the alert history from before this run.
  outcome.safetyNet = await safetyNet(ctx, status);
  outcome.alerts = [...ctx.sent];
  return outcome;
}
