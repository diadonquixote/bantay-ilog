import { z } from "zod";

/** Flood stages, lowest to highest. Mirrors the 1st/2nd/3rd alarm system used on PH rivers. */
export const LEVEL_KEYS = ["normal", "alert", "alarm", "critical"] as const;
export const LevelKey = z.enum(LEVEL_KEYS);
export type LevelKey = z.infer<typeof LevelKey>;

/** What a message to residents is for. Each kind has its own vetted template. */
export const ALERT_KINDS = ["stage", "early", "provisional", "de-escalation", "all-clear"] as const;
export const AlertKind = z.enum(ALERT_KINDS);
export type AlertKind = z.infer<typeof AlertKind>;

export const Thresholds = z
  .object({
    alert: z.number(),
    alarm: z.number(),
    critical: z.number(),
  })
  .refine((t) => t.alert < t.alarm && t.alarm < t.critical, {
    message: "Thresholds must increase: alert < alarm < critical",
  });
export type Thresholds = z.infer<typeof Thresholds>;

export const Station = z.object({
  id: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and dashes"),
  name: z.string().min(1).max(120),
  river: z.string().max(120).default(""),
  location: z.string().max(200).default(""),
  /** Water level unit is metres on the painted staff gauge. */
  gaugeMin: z.number().default(0),
  gaugeMax: z.number().default(20),
  thresholds: Thresholds,
  /** Max difference (m) between AI and observer readings that still counts as agreement. */
  tolerance: z.number().positive().max(2).default(0.1),
  /** Fastest rise this river plausibly manages (m/h); bigger jumps need a human look. */
  maxRatePerHour: z.number().positive().max(20).default(2),
  /** Where residents should go when told to evacuate. Printed in every alert that says to move. */
  evacuationCenter: z.string().max(160).default(""),
  /** Barangay / MDRRMO number printed in alerts. */
  hotline: z.string().max(60).default(""),
  /** Telegram chat ids of the observer team: they get confirmation requests and reading reminders. */
  teamChatIds: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
});
export type Station = z.infer<typeof Station>;

export const ReadingStatus = z.enum(["accepted", "needs_confirmation", "rejected"]);
export type ReadingStatus = z.infer<typeof ReadingStatus>;

export const ReadingSource = z.enum(["photo", "manual", "telegram", "demo"]);
export type ReadingSource = z.infer<typeof ReadingSource>;

export const Reading = z.object({
  id: z.string(),
  stationId: z.string(),
  /** Client-generated id so offline re-sends are idempotent. */
  clientId: z.string().nullable().default(null),
  takenAt: z.string(),
  createdAt: z.string(),
  source: ReadingSource,
  aiLevel: z.number().nullable(),
  aiConfidence: z.number().nullable(),
  aiNotes: z.string().nullable(),
  observerLevel: z.number().nullable(),
  observerName: z.string().nullable(),
  /** Stable identity of the sender (telegram user id, or name:slug) used for the two-person rule. */
  observerKey: z.string().nullable().default(null),
  /** Final level used for trend + alerts (null until accepted). */
  level: z.number().nullable(),
  status: ReadingStatus,
  statusReason: z.string(),
  photoPath: z.string().nullable(),
  /** sha256 of the photo bytes, so the same picture can't be sent twice as a new reading. */
  photoHash: z.string().nullable().default(null),
  confirmedBy: z.string().nullable().default(null),
  confirmedByKey: z.string().nullable().default(null),
});
export type Reading = z.infer<typeof Reading>;

export const Alert = z.object({
  id: z.string(),
  stationId: z.string(),
  readingId: z.string().nullable(),
  level: LevelKey,
  kind: AlertKind,
  message: z.string(),
  /** "agent" = the alert agent chose to send it, "rule" = deterministic fallback/safety net. */
  origin: z.enum(["agent", "rule"]),
  recipients: z.number(),
  /** Unique per (station, kind, level, time bucket): the database refuses a second one. */
  dedupeKey: z.string(),
  createdAt: z.string(),
});
export type Alert = z.infer<typeof Alert>;

export const Subscriber = z.object({
  chatId: z.string(),
  stationId: z.string(),
  name: z.string().nullable(),
  createdAt: z.string(),
});
export type Subscriber = z.infer<typeof Subscriber>;

export const RainfallWarning = z.enum(["none", "yellow", "orange", "red", "unknown"]);
export type RainfallWarning = z.infer<typeof RainfallWarning>;

export const Advisory = z.object({
  id: z.string(),
  warning: RainfallWarning,
  text: z.string(),
  source: z.string(),
  fetchedAt: z.string(),
});
export type Advisory = z.infer<typeof Advisory>;

export const Reminder = z.object({
  id: z.string(),
  stationId: z.string(),
  dueAt: z.string(),
  reason: z.string(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Reminder = z.infer<typeof Reminder>;

export const OutboxMessage = z.object({
  id: z.string(),
  chatId: z.string(),
  text: z.string(),
  delivered: z.boolean(),
  error: z.string().nullable(),
  /** Retries left for an undelivered message; 0 means give up. */
  retries: z.number().default(0),
  createdAt: z.string(),
});
export type OutboxMessage = z.infer<typeof OutboxMessage>;

// ---------- API request bodies ----------

const level = z
  .number({ message: "Level must be a number of metres" })
  .finite()
  .min(-50, "Level looks wrong: below -50 m")
  .max(100, "Level looks wrong: above 100 m. Did you forget the decimal point?");

/** A reading is about now: not from the future, not older than a day. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
export const MAX_READING_AGE_MS = 24 * 3_600_000;

const takenAt = z
  .string()
  .datetime()
  .refine((s) => {
    const t = Date.parse(s);
    const now = Date.now();
    return t <= now + MAX_CLOCK_SKEW_MS && t >= now - MAX_READING_AGE_MS;
  }, "takenAt must be within the last 24 hours and not in the future (check the phone's clock)");

export const FrameRequest = z.object({
  stationId: z.string(),
  /** data:image/jpeg;base64,... (already cropped to the gauge on the device). */
  image: z.string().startsWith("data:image/").max(8_000_000),
  observerLevel: level.nullable().optional(),
  observerName: z.string().max(80).nullable().optional(),
  takenAt: takenAt.optional(),
  clientId: z.string().max(80).optional(),
  /** Only honoured in mock AI mode on the demo station: the true level drawn in the sample. */
  demoLevel: level.optional(),
});
export type FrameRequest = z.infer<typeof FrameRequest>;

export const ConfirmRequest = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("accept"),
    readingId: z.string(),
    level,
    confirmedBy: z.string().min(2, "Enter your name").max(80),
  }),
  z.object({
    action: z.literal("reject"),
    readingId: z.string(),
    confirmedBy: z.string().min(2, "Enter your name").max(80),
  }),
]);
export type ConfirmRequest = z.infer<typeof ConfirmRequest>;

export const ManualReadingRequest = z.object({
  stationId: z.string(),
  level,
  observerName: z.string().max(80),
  takenAt: takenAt.optional(),
  clientId: z.string().max(80).optional(),
});
