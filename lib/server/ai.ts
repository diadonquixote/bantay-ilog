import { readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

/**
 * Server-side refusal fallback: if the model declines a request on policy
 * grounds, the API retries it on its default fallback model in the same call.
 */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type AiMode = "live" | "mock";

export function aiMode(): AiMode {
  if (process.env.AI_MODE === "mock") return "mock";
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "live" : "mock";
}

const g = globalThis as unknown as { __bantayAnthropic?: Anthropic };

export function getAnthropic(): Anthropic {
  g.__bantayAnthropic ??= new Anthropic();
  return g.__bantayAnthropic;
}

const promptCache = new Map<string, string>();

export function loadPrompt(name: "read-gauge" | "alert-agent"): string {
  let text = promptCache.get(name);
  if (!text) {
    text = readFileSync(path.join(process.cwd(), "prompts", `${name}.md`), "utf8");
    promptCache.set(name, text);
  }
  return text;
}

/** Short, log-safe description of an SDK error. */
export function describeAiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Claude API key rejected";
  if (e instanceof Anthropic.RateLimitError) return "Claude API rate limited";
  if (e instanceof Anthropic.BadRequestError) return `Claude API bad request: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API";
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}`;
  return e instanceof Error ? e.message : String(e);
}
