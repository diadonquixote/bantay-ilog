import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Station } from "../schemas";
import { aiMode, describeAiError, FALLBACK_BETA, getAnthropic, loadPrompt, MODEL } from "./ai";

export const GaugeReadingSchema = z.object({
  readable: z.boolean(),
  level_m: z.number().nullable(),
  confidence: z.number(),
  waterline_description: z.string(),
  issues: z.array(
    z.enum(["blurry", "glare", "dark", "obstructed", "gauge_not_visible", "waterline_unclear", "waves", "other"]),
  ),
});
export type GaugeReadingOutput = z.infer<typeof GaugeReadingSchema>;

export interface GaugeRead {
  level: number | null;
  confidence: number | null;
  notes: string;
  mode: "live" | "mock";
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export function parseDataUrl(dataUrl: string): { mediaType: ImageMediaType; base64: string } {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error("Image must be a base64 data URL (jpeg, png, webp or gif).");
  return { mediaType: m[1] as ImageMediaType, base64: m[2] };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Turn the model's structured answer into a GaugeRead, rejecting impossible values. */
export function interpretGaugeOutput(out: GaugeReadingOutput, station: Station): GaugeRead {
  const issues = out.issues.length ? ` Issues: ${out.issues.join(", ")}.` : "";
  const notes = `${out.waterline_description}${issues}`.trim();
  if (!out.readable || out.level_m == null || !Number.isFinite(out.level_m)) {
    return { level: null, confidence: clamp01(out.confidence), notes: notes || "Gauge not readable.", mode: "live" };
  }
  if (out.level_m < station.gaugeMin - 1 || out.level_m > station.gaugeMax + 1) {
    return {
      level: null,
      confidence: 0,
      notes: `Model reported ${out.level_m} m, outside this gauge (${station.gaugeMin}–${station.gaugeMax} m). ${notes}`,
      mode: "live",
    };
  }
  return { level: Math.round(out.level_m * 100) / 100, confidence: clamp01(out.confidence), notes, mode: "live" };
}

/**
 * Read the water level from a gauge photo.
 *
 * Live mode asks Claude (vision + structured output). Mock mode cannot see the
 * image: it only answers for the demo station, where the sample's true level is
 * passed in as `demoLevel`; any other photo comes back unreadable so a human
 * has to confirm it.
 */
export async function readGauge(args: {
  imageDataUrl: string;
  station: Station;
  demoLevel?: number;
}): Promise<GaugeRead> {
  const { station } = args;

  if (aiMode() === "mock") {
    if (args.demoLevel != null && station.id === "demo") {
      // Deterministic ±3 cm "misread" so agreement logic is exercised.
      const jitter = ((Math.round(args.demoLevel * 100) % 7) - 3) / 100;
      return {
        level: Math.round((args.demoLevel + jitter) * 100) / 100,
        confidence: 0.9,
        notes: "Mock AI (no ANTHROPIC_API_KEY): level taken from the demo sample.",
        mode: "mock",
      };
    }
    return {
      level: null,
      confidence: null,
      notes: "Mock AI mode (no ANTHROPIC_API_KEY): photo was stored but not read.",
      mode: "mock",
    };
  }

  const { mediaType, base64 } = parseDataUrl(args.imageDataUrl);
  try {
    const response = await getAnthropic().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "high", format: betaZodOutputFormat(GaugeReadingSchema) },
      system: loadPrompt("read-gauge"),
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            {
              type: "text",
              text:
                `Station: ${station.name} (${station.river}). ` +
                `This gauge is marked from ${station.gaugeMin} m to ${station.gaugeMax} m. ` +
                "Read the water level.",
            },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return { level: null, confidence: null, notes: "Model declined to read this photo.", mode: "live" };
    }
    if (!response.parsed_output) {
      return { level: null, confidence: null, notes: `No structured answer (stop: ${response.stop_reason}).`, mode: "live" };
    }
    return interpretGaugeOutput(response.parsed_output, station);
  } catch (e) {
    // The photo is still stored; a human can confirm the reading.
    return { level: null, confidence: null, notes: `AI read failed: ${describeAiError(e)}`, mode: "live" };
  }
}
