import { promises as fs } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_STATION, DEMO_STATION } from "../levels";
import type { Advisory, Alert, OutboxMessage, Reading, Reminder, Station, Subscriber } from "../schemas";

export interface ReadingQuery {
  sinceIso?: string;
  status?: Reading["status"];
  limit?: number;
}

/** Thrown when an alert with the same dedupe key is already stored: someone else got there first. */
export class DuplicateAlertError extends Error {}

/** Storage used by the whole app. Two implementations: Supabase, or a local JSON file / memory. */
export interface Db {
  readonly kind: "supabase" | "file" | "memory";
  listStations(): Promise<Station[]>;
  getStation(id: string): Promise<Station | null>;
  upsertStation(s: Station): Promise<Station>;

  /** Returns the stored row; a repeat of the same clientId returns the original reading. */
  insertReading(r: Reading): Promise<Reading>;
  updateReading(id: string, patch: Partial<Reading>): Promise<Reading | null>;
  getReading(id: string): Promise<Reading | null>;
  findReadingByClientId(stationId: string, clientId: string): Promise<Reading | null>;
  findReadingByPhotoHash(stationId: string, hash: string, sinceIso: string): Promise<Reading | null>;
  /** Newest first. */
  listReadings(stationId: string, q?: ReadingQuery): Promise<Reading[]>;

  /** Throws DuplicateAlertError when the dedupe key is taken. */
  insertAlert(a: Alert): Promise<Alert>;
  updateAlertRecipients(id: string, recipients: number): Promise<void>;
  /** Newest first. */
  listAlerts(stationId: string, sinceIso?: string): Promise<Alert[]>;

  addSubscriber(s: Subscriber): Promise<void>;
  removeSubscriber(chatId: string, stationId?: string): Promise<number>;
  listSubscribers(stationId: string): Promise<Subscriber[]>;
  listSubscriptions(chatId: string): Promise<Subscriber[]>;

  insertAdvisory(a: Advisory): Promise<void>;
  latestAdvisory(): Promise<Advisory | null>;

  insertReminder(r: Reminder): Promise<void>;
  listReminders(q: { stationId?: string; dueBeforeIso?: string; unsentOnly?: boolean }): Promise<Reminder[]>;
  markReminderSent(id: string, sentAt: string): Promise<void>;
  purgeReminders(beforeIso: string): Promise<number>;

  insertOutbox(m: OutboxMessage): Promise<void>;
  listOutbox(limit?: number): Promise<OutboxMessage[]>;
  /** Undelivered messages that still have retries left, oldest first. */
  listOutboxPending(limit?: number): Promise<OutboxMessage[]>;
  updateOutbox(id: string, patch: { delivered?: boolean; error?: string | null; retries?: number }): Promise<void>;

  savePhoto(key: string, bytes: Buffer, contentType: string): Promise<string>;
  loadPhoto(photoPath: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  /** Delete photos for readings older than `beforeIso` and clear their photoPath. Returns the count. */
  purgePhotos(beforeIso: string): Promise<number>;

  /** Small key/value store for things like the last successful background tick. */
  setMeta(key: string, value: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;

  /** Delete all readings/alerts/reminders for a station (used by the demo reset). */
  resetStation(stationId: string): Promise<void>;
}

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// File / memory implementation
// ---------------------------------------------------------------------------

interface FileState {
  stations: Station[];
  readings: Reading[];
  alerts: Alert[];
  subscribers: Subscriber[];
  advisories: Advisory[];
  reminders: Reminder[];
  outbox: OutboxMessage[];
  meta: Record<string, string>;
}

const emptyState = (): FileState => ({
  stations: [
    { ...DEFAULT_STATION, createdAt: nowIso() },
    { ...DEMO_STATION, createdAt: nowIso() },
  ],
  readings: [],
  alerts: [],
  subscribers: [],
  advisories: [],
  reminders: [],
  outbox: [],
  meta: {},
});

const byNewest = <T>(get: (x: T) => string) => (a: T, b: T) => Date.parse(get(b)) - Date.parse(get(a));

/**
 * Single-file JSON store for running without Supabase. The web server and the
 * pagasa-check job may both use it, so the file is re-read whenever another
 * process has changed it. Within a process all access is serialised so a
 * reload can never drop an in-flight write. Cross-process writes are
 * last-writer-wins; use Supabase for real deployments.
 */
export class FileDb implements Db {
  readonly kind: "file" | "memory";
  private state: FileState | null = null;
  private mtimeMs = -1;
  private lock: Promise<unknown> = Promise.resolve();

  /** `dir` null = in-memory only (tests). */
  constructor(private readonly dir: string | null, seed?: Partial<FileState>) {
    this.kind = dir ? "file" : "memory";
    if (!dir) this.state = { ...emptyState(), ...seed };
  }

  private get file() {
    return path.join(this.dir!, "db.json");
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /** Current state, re-read from disk if the file changed since we last saw it. Call inside `exclusive`. */
  private async fresh(): Promise<FileState> {
    if (!this.dir) return this.state!;
    try {
      const st = await fs.stat(this.file);
      if (!this.state || st.mtimeMs !== this.mtimeMs) {
        this.state = { ...emptyState(), ...JSON.parse(await fs.readFile(this.file, "utf8")) } as FileState;
        this.mtimeMs = st.mtimeMs;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.state ??= emptyState();
    }
    return this.state!;
  }

  private load(): Promise<FileState> {
    return this.exclusive(() => this.fresh());
  }

  private mutate<T>(fn: (s: FileState) => T): Promise<T> {
    return this.exclusive(async () => {
      const s = await this.fresh();
      const result = fn(s);
      if (this.dir) {
        await fs.mkdir(this.dir, { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(s, null, 1));
        await fs.rename(tmp, this.file);
        this.mtimeMs = (await fs.stat(this.file)).mtimeMs;
      }
      return result;
    });
  }

  async listStations() {
    return [...(await this.load()).stations];
  }
  async getStation(id: string) {
    return (await this.load()).stations.find((s) => s.id === id) ?? null;
  }
  async upsertStation(st: Station) {
    return this.mutate((s) => {
      const i = s.stations.findIndex((x) => x.id === st.id);
      const value = { ...st, createdAt: st.createdAt ?? nowIso() };
      if (i >= 0) s.stations[i] = value;
      else s.stations.push(value);
      return value;
    });
  }

  async insertReading(r: Reading) {
    return this.mutate((s) => {
      if (r.clientId) {
        const existing = s.readings.find((x) => x.stationId === r.stationId && x.clientId === r.clientId);
        if (existing) return existing;
      }
      s.readings.push(r);
      return r;
    });
  }
  async updateReading(id: string, patch: Partial<Reading>) {
    return this.mutate((s) => {
      const r = s.readings.find((x) => x.id === id);
      if (!r) return null;
      Object.assign(r, patch, { id: r.id });
      return { ...r };
    });
  }
  async getReading(id: string) {
    return (await this.load()).readings.find((r) => r.id === id) ?? null;
  }
  async findReadingByClientId(stationId: string, clientId: string) {
    return (await this.load()).readings.find((r) => r.stationId === stationId && r.clientId === clientId) ?? null;
  }
  async findReadingByPhotoHash(stationId: string, hash: string, sinceIso: string) {
    const since = Date.parse(sinceIso);
    return (
      (await this.load()).readings
        .filter((r) => r.stationId === stationId && r.photoHash === hash && Date.parse(r.takenAt) >= since)
        .sort(byNewest((r) => r.takenAt))[0] ?? null
    );
  }
  async listReadings(stationId: string, q: ReadingQuery = {}) {
    const since = q.sinceIso ? Date.parse(q.sinceIso) : -Infinity;
    const rows = (await this.load()).readings
      .filter((r) => r.stationId === stationId && Date.parse(r.takenAt) >= since && (!q.status || r.status === q.status))
      .sort(byNewest((r) => r.takenAt));
    return q.limit ? rows.slice(0, q.limit) : rows;
  }

  async insertAlert(a: Alert) {
    return this.mutate((s) => {
      if (s.alerts.some((x) => x.dedupeKey === a.dedupeKey)) {
        throw new DuplicateAlertError(`alert ${a.dedupeKey} already sent`);
      }
      s.alerts.push(a);
      return a;
    });
  }
  async updateAlertRecipients(id: string, recipients: number) {
    await this.mutate((s) => {
      const a = s.alerts.find((x) => x.id === id);
      if (a) a.recipients = recipients;
    });
  }
  async listAlerts(stationId: string, sinceIso?: string) {
    const since = sinceIso ? Date.parse(sinceIso) : -Infinity;
    return (await this.load()).alerts
      .filter((a) => a.stationId === stationId && Date.parse(a.createdAt) >= since)
      .sort(byNewest((a) => a.createdAt));
  }

  async addSubscriber(sub: Subscriber) {
    await this.mutate((s) => {
      if (!s.subscribers.some((x) => x.chatId === sub.chatId && x.stationId === sub.stationId)) s.subscribers.push(sub);
    });
  }
  async removeSubscriber(chatId: string, stationId?: string) {
    return this.mutate((s) => {
      const before = s.subscribers.length;
      s.subscribers = s.subscribers.filter((x) => !(x.chatId === chatId && (!stationId || x.stationId === stationId)));
      return before - s.subscribers.length;
    });
  }
  async listSubscribers(stationId: string) {
    return (await this.load()).subscribers.filter((x) => x.stationId === stationId);
  }
  async listSubscriptions(chatId: string) {
    return (await this.load()).subscribers.filter((x) => x.chatId === chatId);
  }

  async insertAdvisory(a: Advisory) {
    await this.mutate((s) => {
      s.advisories.push(a);
      s.advisories = s.advisories.sort(byNewest((x) => x.fetchedAt)).slice(0, 50);
    });
  }
  async latestAdvisory() {
    return [...(await this.load()).advisories].sort(byNewest((x) => x.fetchedAt))[0] ?? null;
  }

  async insertReminder(r: Reminder) {
    await this.mutate((s) => {
      s.reminders.push(r);
    });
  }
  async listReminders(q: { stationId?: string; dueBeforeIso?: string; unsentOnly?: boolean }) {
    const due = q.dueBeforeIso ? Date.parse(q.dueBeforeIso) : Infinity;
    return (await this.load()).reminders.filter(
      (r) => (!q.stationId || r.stationId === q.stationId) && Date.parse(r.dueAt) <= due && (!q.unsentOnly || !r.sentAt),
    );
  }
  async markReminderSent(id: string, sentAt: string) {
    await this.mutate((s) => {
      const r = s.reminders.find((x) => x.id === id);
      if (r) r.sentAt = sentAt;
    });
  }
  async purgeReminders(beforeIso: string) {
    const before = Date.parse(beforeIso);
    return this.mutate((s) => {
      const n = s.reminders.length;
      s.reminders = s.reminders.filter((r) => !r.sentAt || Date.parse(r.createdAt) >= before);
      return n - s.reminders.length;
    });
  }

  async insertOutbox(m: OutboxMessage) {
    await this.mutate((s) => {
      s.outbox.push(m);
      if (s.outbox.length > 500) s.outbox = s.outbox.slice(-500);
    });
  }
  async listOutbox(limit = 50) {
    return [...(await this.load()).outbox].sort(byNewest((m) => m.createdAt)).slice(0, limit);
  }
  async listOutboxPending(limit = 50) {
    return (await this.load()).outbox
      .filter((m) => !m.delivered && (m.retries ?? 0) > 0)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(0, limit);
  }
  async updateOutbox(id: string, patch: { delivered?: boolean; error?: string | null; retries?: number }) {
    await this.mutate((s) => {
      const m = s.outbox.find((x) => x.id === id);
      if (m) Object.assign(m, patch);
    });
  }

  private memPhotos = new Map<string, { bytes: Buffer; contentType: string }>();
  async savePhoto(key: string, bytes: Buffer, contentType: string) {
    if (!this.dir) {
      this.memPhotos.set(key, { bytes, contentType });
      return key;
    }
    const file = path.join(this.dir, "photos", key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return key;
  }
  async loadPhoto(photoPath: string) {
    if (!this.dir) return this.memPhotos.get(photoPath) ?? null;
    const root = path.resolve(this.dir, "photos");
    const file = path.resolve(root, photoPath);
    if (!file.startsWith(root + path.sep)) return null;
    try {
      const bytes = await fs.readFile(file);
      const contentType = photoPath.endsWith(".png") ? "image/png" : photoPath.endsWith(".webp") ? "image/webp" : "image/jpeg";
      return { bytes, contentType };
    } catch {
      return null;
    }
  }
  async purgePhotos(beforeIso: string) {
    const before = Date.parse(beforeIso);
    const stale = (await this.load()).readings.filter((r) => r.photoPath && Date.parse(r.takenAt) < before);
    for (const r of stale) {
      if (!r.photoPath) continue;
      if (this.dir) {
        const root = path.resolve(this.dir, "photos");
        const file = path.resolve(root, r.photoPath);
        if (file.startsWith(root + path.sep)) await fs.rm(file, { force: true });
      } else {
        this.memPhotos.delete(r.photoPath);
      }
    }
    if (stale.length) {
      const ids = new Set(stale.map((r) => r.id));
      await this.mutate((s) => {
        for (const r of s.readings) if (ids.has(r.id)) r.photoPath = null;
      });
    }
    return stale.length;
  }

  async setMeta(key: string, value: string) {
    await this.mutate((s) => {
      s.meta = { ...s.meta, [key]: value };
    });
  }
  async getMeta(key: string) {
    return (await this.load()).meta?.[key] ?? null;
  }

  async resetStation(stationId: string) {
    await this.mutate((s) => {
      s.readings = s.readings.filter((r) => r.stationId !== stationId);
      s.alerts = s.alerts.filter((a) => a.stationId !== stationId);
      s.reminders = s.reminders.filter((r) => r.stationId !== stationId);
    });
  }
}

// ---------------------------------------------------------------------------
// Supabase implementation (tables defined in supabase/schema.sql)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const stationToRow = (s: Station): Row => ({
  id: s.id,
  name: s.name,
  river: s.river,
  location: s.location,
  gauge_min: s.gaugeMin,
  gauge_max: s.gaugeMax,
  threshold_alert: s.thresholds.alert,
  threshold_alarm: s.thresholds.alarm,
  threshold_critical: s.thresholds.critical,
  tolerance: s.tolerance,
  max_rate_per_hour: s.maxRatePerHour,
  evacuation_center: s.evacuationCenter,
  hotline: s.hotline,
  team_chat_ids: s.teamChatIds,
});
const rowToStation = (r: Row): Station => ({
  id: r.id as string,
  name: r.name as string,
  river: (r.river as string) ?? "",
  location: (r.location as string) ?? "",
  gaugeMin: Number(r.gauge_min),
  gaugeMax: Number(r.gauge_max),
  thresholds: {
    alert: Number(r.threshold_alert),
    alarm: Number(r.threshold_alarm),
    critical: Number(r.threshold_critical),
  },
  tolerance: Number(r.tolerance),
  maxRatePerHour: r.max_rate_per_hour == null ? 2 : Number(r.max_rate_per_hour),
  evacuationCenter: (r.evacuation_center as string) ?? "",
  hotline: (r.hotline as string) ?? "",
  teamChatIds: (r.team_chat_ids as string[]) ?? [],
  createdAt: r.created_at as string,
});

const num = (v: unknown) => (v == null ? null : Number(v));

const readingToRow = (r: Partial<Reading>): Row => {
  const map: Record<string, keyof Reading> = {
    id: "id",
    station_id: "stationId",
    client_id: "clientId",
    taken_at: "takenAt",
    created_at: "createdAt",
    source: "source",
    ai_level: "aiLevel",
    ai_confidence: "aiConfidence",
    ai_notes: "aiNotes",
    observer_level: "observerLevel",
    observer_name: "observerName",
    observer_key: "observerKey",
    level: "level",
    status: "status",
    status_reason: "statusReason",
    photo_path: "photoPath",
    photo_hash: "photoHash",
    confirmed_by: "confirmedBy",
    confirmed_by_key: "confirmedByKey",
  };
  const row: Row = {};
  for (const [col, key] of Object.entries(map)) if (key in r) row[col] = r[key];
  return row;
};
const rowToReading = (r: Row): Reading => ({
  id: r.id as string,
  stationId: r.station_id as string,
  clientId: (r.client_id as string) ?? null,
  takenAt: r.taken_at as string,
  createdAt: r.created_at as string,
  source: r.source as Reading["source"],
  aiLevel: num(r.ai_level),
  aiConfidence: num(r.ai_confidence),
  aiNotes: (r.ai_notes as string) ?? null,
  observerLevel: num(r.observer_level),
  observerName: (r.observer_name as string) ?? null,
  observerKey: (r.observer_key as string) ?? null,
  level: num(r.level),
  status: r.status as Reading["status"],
  statusReason: (r.status_reason as string) ?? "",
  photoPath: (r.photo_path as string) ?? null,
  photoHash: (r.photo_hash as string) ?? null,
  confirmedBy: (r.confirmed_by as string) ?? null,
  confirmedByKey: (r.confirmed_by_key as string) ?? null,
});
const rowToAlert = (r: Row): Alert => ({
  id: r.id as string,
  stationId: r.station_id as string,
  readingId: (r.reading_id as string) ?? null,
  level: r.level as Alert["level"],
  kind: (r.kind as Alert["kind"]) ?? "stage",
  message: r.message as string,
  origin: r.origin as Alert["origin"],
  recipients: Number(r.recipients),
  dedupeKey: (r.dedupe_key as string) ?? (r.id as string),
  createdAt: r.created_at as string,
});
const rowToSub = (r: Row): Subscriber => ({
  chatId: r.chat_id as string,
  stationId: r.station_id as string,
  name: (r.name as string) ?? null,
  createdAt: r.created_at as string,
});
const rowToReminder = (r: Row): Reminder => ({
  id: r.id as string,
  stationId: r.station_id as string,
  dueAt: r.due_at as string,
  reason: r.reason as string,
  sentAt: (r.sent_at as string) ?? null,
  createdAt: r.created_at as string,
});
const rowToOutbox = (r: Row): OutboxMessage => ({
  id: r.id as string,
  chatId: r.chat_id as string,
  text: r.text as string,
  delivered: Boolean(r.delivered),
  error: (r.error as string) ?? null,
  retries: r.retries == null ? 0 : Number(r.retries),
  createdAt: r.created_at as string,
});

const UNIQUE_VIOLATION = "23505";

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`Supabase: ${res.error.message}`);
  return res.data;
}

const isUnique = (error: unknown): boolean =>
  !!error && typeof error === "object" && (error as { code?: string }).code === UNIQUE_VIOLATION;

export class SupabaseDb implements Db {
  readonly kind = "supabase" as const;
  constructor(
    private readonly sb: SupabaseClient,
    private readonly bucket: string,
  ) {}

  async listStations() {
    return (check(await this.sb.from("stations").select("*").order("created_at")) as Row[]).map(rowToStation);
  }
  async getStation(id: string) {
    const row = check(await this.sb.from("stations").select("*").eq("id", id).maybeSingle()) as Row | null;
    return row ? rowToStation(row) : null;
  }
  async upsertStation(s: Station) {
    return rowToStation(check(await this.sb.from("stations").upsert(stationToRow(s)).select().single()) as Row);
  }

  async insertReading(r: Reading) {
    const res = await this.sb.from("readings").insert(readingToRow(r)).select().single();
    if (res.error) {
      // A retried offline send races with the first one: hand back the stored row.
      if (isUnique(res.error) && r.clientId) {
        const existing = await this.findReadingByClientId(r.stationId, r.clientId);
        if (existing) return existing;
      }
      throw new Error(`Supabase: ${res.error.message}`);
    }
    return rowToReading(res.data as Row);
  }
  async updateReading(id: string, patch: Partial<Reading>) {
    const { id: _ignored, ...rest } = patch;
    const row = check(
      await this.sb.from("readings").update(readingToRow(rest)).eq("id", id).select().maybeSingle(),
    ) as Row | null;
    return row ? rowToReading(row) : null;
  }
  async getReading(id: string) {
    const row = check(await this.sb.from("readings").select("*").eq("id", id).maybeSingle()) as Row | null;
    return row ? rowToReading(row) : null;
  }
  async findReadingByClientId(stationId: string, clientId: string) {
    const row = check(
      await this.sb.from("readings").select("*").eq("station_id", stationId).eq("client_id", clientId).maybeSingle(),
    ) as Row | null;
    return row ? rowToReading(row) : null;
  }
  async findReadingByPhotoHash(stationId: string, hash: string, sinceIso: string) {
    const rows = check(
      await this.sb
        .from("readings")
        .select("*")
        .eq("station_id", stationId)
        .eq("photo_hash", hash)
        .gte("taken_at", sinceIso)
        .order("taken_at", { ascending: false })
        .limit(1),
    ) as Row[];
    return rows[0] ? rowToReading(rows[0]) : null;
  }
  async listReadings(stationId: string, q: ReadingQuery = {}) {
    let query = this.sb.from("readings").select("*").eq("station_id", stationId).order("taken_at", { ascending: false });
    if (q.sinceIso) query = query.gte("taken_at", q.sinceIso);
    if (q.status) query = query.eq("status", q.status);
    if (q.limit) query = query.limit(q.limit);
    return (check(await query) as Row[]).map(rowToReading);
  }

  async insertAlert(a: Alert) {
    const res = await this.sb
      .from("alerts")
      .insert({
        id: a.id,
        station_id: a.stationId,
        reading_id: a.readingId,
        level: a.level,
        kind: a.kind,
        message: a.message,
        origin: a.origin,
        recipients: a.recipients,
        dedupe_key: a.dedupeKey,
        created_at: a.createdAt,
      })
      .select()
      .single();
    if (res.error) {
      if (isUnique(res.error)) throw new DuplicateAlertError(`alert ${a.dedupeKey} already sent`);
      throw new Error(`Supabase: ${res.error.message}`);
    }
    return rowToAlert(res.data as Row);
  }
  async updateAlertRecipients(id: string, recipients: number) {
    check(await this.sb.from("alerts").update({ recipients }).eq("id", id));
  }
  async listAlerts(stationId: string, sinceIso?: string) {
    let query = this.sb.from("alerts").select("*").eq("station_id", stationId).order("created_at", { ascending: false });
    if (sinceIso) query = query.gte("created_at", sinceIso);
    return (check(await query.limit(200)) as Row[]).map(rowToAlert);
  }

  async addSubscriber(s: Subscriber) {
    check(
      await this.sb
        .from("subscribers")
        .upsert({ chat_id: s.chatId, station_id: s.stationId, name: s.name, created_at: s.createdAt }, {
          onConflict: "chat_id,station_id",
        }),
    );
  }
  async removeSubscriber(chatId: string, stationId?: string) {
    let query = this.sb.from("subscribers").delete().eq("chat_id", chatId);
    if (stationId) query = query.eq("station_id", stationId);
    return (check(await query.select()) as Row[]).length;
  }
  async listSubscribers(stationId: string) {
    return (check(await this.sb.from("subscribers").select("*").eq("station_id", stationId)) as Row[]).map(rowToSub);
  }
  async listSubscriptions(chatId: string) {
    return (check(await this.sb.from("subscribers").select("*").eq("chat_id", chatId)) as Row[]).map(rowToSub);
  }

  async insertAdvisory(a: Advisory) {
    check(
      await this.sb
        .from("advisories")
        .insert({ id: a.id, warning: a.warning, text: a.text, source: a.source, fetched_at: a.fetchedAt }),
    );
  }
  async latestAdvisory() {
    const row = check(
      await this.sb.from("advisories").select("*").order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
    ) as Row | null;
    return row
      ? {
          id: row.id as string,
          warning: row.warning as Advisory["warning"],
          text: row.text as string,
          source: row.source as string,
          fetchedAt: row.fetched_at as string,
        }
      : null;
  }

  async insertReminder(r: Reminder) {
    check(
      await this.sb.from("reminders").insert({
        id: r.id,
        station_id: r.stationId,
        due_at: r.dueAt,
        reason: r.reason,
        sent_at: r.sentAt,
        created_at: r.createdAt,
      }),
    );
  }
  async listReminders(q: { stationId?: string; dueBeforeIso?: string; unsentOnly?: boolean }) {
    let query = this.sb.from("reminders").select("*");
    if (q.stationId) query = query.eq("station_id", q.stationId);
    if (q.dueBeforeIso) query = query.lte("due_at", q.dueBeforeIso);
    if (q.unsentOnly) query = query.is("sent_at", null);
    return (check(await query.order("due_at", { ascending: false }).limit(500)) as Row[]).map(rowToReminder);
  }
  async markReminderSent(id: string, sentAt: string) {
    check(await this.sb.from("reminders").update({ sent_at: sentAt }).eq("id", id));
  }
  async purgeReminders(beforeIso: string) {
    const rows = check(
      await this.sb.from("reminders").delete().lt("created_at", beforeIso).not("sent_at", "is", null).select(),
    ) as Row[];
    return rows.length;
  }

  async insertOutbox(m: OutboxMessage) {
    check(
      await this.sb.from("outbox").insert({
        id: m.id,
        chat_id: m.chatId,
        text: m.text,
        delivered: m.delivered,
        error: m.error,
        retries: m.retries,
        created_at: m.createdAt,
      }),
    );
  }
  async listOutbox(limit = 50) {
    const rows = check(
      await this.sb.from("outbox").select("*").order("created_at", { ascending: false }).limit(limit),
    ) as Row[];
    return rows.map(rowToOutbox);
  }
  async listOutboxPending(limit = 50) {
    const rows = check(
      await this.sb
        .from("outbox")
        .select("*")
        .eq("delivered", false)
        .gt("retries", 0)
        .order("created_at", { ascending: true })
        .limit(limit),
    ) as Row[];
    return rows.map(rowToOutbox);
  }
  async updateOutbox(id: string, patch: { delivered?: boolean; error?: string | null; retries?: number }) {
    check(await this.sb.from("outbox").update(patch).eq("id", id));
  }

  async savePhoto(key: string, bytes: Buffer, contentType: string) {
    check(await this.sb.storage.from(this.bucket).upload(key, bytes, { contentType, upsert: true }));
    return key;
  }
  async loadPhoto(photoPath: string) {
    const { data, error } = await this.sb.storage.from(this.bucket).download(photoPath);
    if (error || !data) return null;
    return { bytes: Buffer.from(await data.arrayBuffer()), contentType: data.type || "image/jpeg" };
  }
  async purgePhotos(beforeIso: string) {
    const rows = check(
      await this.sb.from("readings").select("id,photo_path").lt("taken_at", beforeIso).not("photo_path", "is", null).limit(500),
    ) as Row[];
    if (!rows.length) return 0;
    const paths = rows.map((r) => r.photo_path as string);
    await this.sb.storage.from(this.bucket).remove(paths);
    check(
      await this.sb
        .from("readings")
        .update({ photo_path: null })
        .in("id", rows.map((r) => r.id as string)),
    );
    return rows.length;
  }

  async setMeta(key: string, value: string) {
    check(await this.sb.from("meta").upsert({ key, value, updated_at: nowIso() }, { onConflict: "key" }));
  }
  async getMeta(key: string) {
    const row = check(await this.sb.from("meta").select("value").eq("key", key).maybeSingle()) as Row | null;
    return row ? (row.value as string) : null;
  }

  async resetStation(stationId: string) {
    for (const table of ["alerts", "reminders", "readings"]) {
      check(await this.sb.from(table).delete().eq("station_id", stationId));
    }
  }
}

// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __bantayDb?: Db };

/**
 * Process-wide database. Stored on globalThis so every Next.js route bundle
 * (and hot reloads in dev) share one instance and one in-memory cache.
 */
export function getDb(): Db {
  if (g.__bantayDb) return g.__bantayDb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  g.__bantayDb =
    url && key
      ? new SupabaseDb(createClient(url, key, { auth: { persistSession: false } }), process.env.SUPABASE_PHOTO_BUCKET || "gauge-photos")
      : new FileDb(path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || ".data"));
  return g.__bantayDb;
}

/** For tests and scripts. */
export function setDb(db: Db) {
  g.__bantayDb = db;
}
