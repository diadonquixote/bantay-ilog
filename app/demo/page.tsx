"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, useAdminToken } from "@/components/api";
import { LevelBadge } from "@/components/LevelBadge";
import { StaffGauge } from "@/components/StaffGauge";
import { urlToCanvas } from "@/lib/client/camera";
import { toJpegDataUrl } from "@/lib/client/crop";
import { DEMO_LEVELS, sampleName } from "@/lib/gaugeSvg";
import { classify, DEMO_STATION, formatLevel } from "@/lib/levels";
import type { Alert, OutboxMessage, Reading } from "@/lib/schemas";

interface Outcome {
  mode: string;
  summary: string;
  alerts: Alert[];
  safetyNet: Alert[];
  steps: { tool: string; isError: boolean; result: unknown }[];
}
interface FrameResponse {
  reading: Reading;
  outcome: Outcome | null;
  provisional?: Alert[];
  ai: { level: number | null; confidence: number | null; notes: string; mode: string };
  aiMode: string;
}

interface Step {
  i: number;
  trueLevel: number;
  observer: number;
  image: string;
  res?: FrameResponse;
  confirmed?: { level: number; outcome: Outcome | null };
  error?: string;
}

const STEP_MIN = 15;
/** Step 6: the observer mistypes 3.95 instead of ~3.80, so a team member has to confirm. */
const OBSERVER_OVERRIDE: Record<number, number> = { 6: 3.95 };

export default function DemoPage() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<OutboxMessage[] | null>(null);
  const [aiMode, setAiMode] = useState<string>("…");
  const [adminRequired, setAdminRequired] = useState(false);
  const [token, setToken] = useAdminToken();

  useEffect(() => {
    api<{ system: { ai: string; adminTokenRequired: boolean } }>("/api/readings")
      .then((d) => {
        setAiMode(d.system.ai);
        setAdminRequired(d.system.adminTokenRequired);
      })
      .catch(() => {});
  }, []);

  const update = (i: number, patch: Partial<Step>) => setSteps((s) => s.map((x) => (x.i === i ? { ...x, ...patch } : x)));

  const run = async () => {
    setRunning(true);
    setError(null);
    setOutbox(null);
    setSteps([]);
    try {
      await api("/api/readings?stationId=demo", { method: "DELETE" });
      const start = Date.now() - (DEMO_LEVELS.length - 1) * STEP_MIN * 60_000;

      for (let i = 0; i < DEMO_LEVELS.length; i++) {
        const trueLevel = DEMO_LEVELS[i];
        const observer = OBSERVER_OVERRIDE[i] ?? trueLevel;
        const image = toJpegDataUrl(await urlToCanvas(`/samples/${sampleName(trueLevel)}`, 360));
        const step: Step = { i, trueLevel, observer, image };
        setSteps((s) => [...s, step]);

        try {
          const res = await api<FrameResponse>("/api/frame?wait=1", {
            method: "POST",
            json: {
              stationId: "demo",
              image,
              observerLevel: observer,
              observerName: "Demo observer",
              takenAt: new Date(start + i * STEP_MIN * 60_000).toISOString(),
              clientId: crypto.randomUUID(),
              demoLevel: trueLevel,
            },
          });
          update(i, { res });

          if (res.reading.status === "needs_confirmation") {
            const level = res.reading.aiLevel ?? trueLevel;
            const c = await api<{ reading: Reading; outcome: Outcome | null }>("/api/confirm", {
              method: "POST",
              json: { action: "accept", readingId: res.reading.id, level, confirmedBy: "Demo team leader" },
            });
            update(i, { confirmed: { level: c.reading.level!, outcome: c.outcome } });
          }
        } catch (e) {
          update(i, { error: (e as Error).message });
        }
      }

      const d = await api<{ outbox: OutboxMessage[] | null }>("/api/readings?stationId=demo&hours=6");
      setOutbox(d.outbox?.filter((m) => m.chatId.startsWith("demo-")) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const finals = steps
    .map((s) => s.confirmed?.level ?? s.res?.reading.level ?? null)
    .filter((v): v is number => v != null);
  const shownLevel = finals.at(-1) ?? null;
  const done = steps.filter((s) => s.res || s.error).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Demo: a rising river</h1>
          <p className="muted">Two hours of a flood in a few seconds, through the real system.</p>
        </div>
      </div>
      <section className="card" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "1rem 1.5rem", alignItems: "start" }}>
        <div>
          <p style={{ marginTop: 0 }}>
            Sends {DEMO_LEVELS.length} gauge photos, {STEP_MIN} minutes apart, for a demo station with alarms at{" "}
            <strong>{DEMO_STATION.thresholds.alert} m</strong>, <strong>{DEMO_STATION.thresholds.alarm} m</strong> and{" "}
            <strong>{DEMO_STATION.thresholds.critical} m</strong>. At step 7 the volunteer types a wrong number, so a team
            leader has to confirm it.
          </p>
          <p className="hint">
            {aiMode === "mock"
              ? "The AI reader is off, so each photo's true level (with a small error) stands in for the AI reading."
              : "Claude reads each gauge photo for real."}
          </p>
          {adminRequired && (
            <div style={{ maxWidth: 300 }}>
              <label htmlFor="demo-token">Admin token</label>
              <input id="demo-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
            </div>
          )}
          <div className="row" style={{ marginTop: "1rem" }}>
            <button onClick={run} disabled={running}>
              {running ? "Running…" : steps.length ? "Run again" : "Run demo"}
            </button>
            <Link className="button secondary" href="/dashboard?station=demo">
              Open demo dashboard
            </Link>
          </div>
          {(running || steps.length > 0) && (
            <div style={{ marginTop: "1rem" }}>
              <progress max={DEMO_LEVELS.length} value={done} style={{ width: "100%", accentColor: "var(--accent)" }} aria-label="Demo progress" />
              <p className="hint" role="status">
                {done} of {DEMO_LEVELS.length} readings processed
              </p>
            </div>
          )}
          {error && <div className="notice error">{error}</div>}
        </div>
        <StaffGauge station={DEMO_STATION} level={shownLevel} height={240} />
      </section>

      {steps.map((s) => {
        const r = s.res?.reading;
        const outcome = s.confirmed?.outcome ?? s.res?.outcome ?? null;
        const final = s.confirmed?.level ?? r?.level ?? null;
        return (
          <div key={s.i} className="card">
            <div className="row" style={{ alignItems: "flex-start", gap: "1rem", flexWrap: "nowrap" }}>
              <img src={s.image} alt={`Synthetic gauge at ${s.trueLevel} m`} style={{ width: 90, borderRadius: 6, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>
                    Step {s.i + 1} · +{s.i * STEP_MIN} min
                  </strong>
                  {final != null && <LevelBadge stage={classify(final, DEMO_STATION.thresholds)} />}
                </div>
                <div className="small">
                  True level {formatLevel(s.trueLevel)} · Observer typed {formatLevel(s.observer)} · AI read{" "}
                  {s.res ? formatLevel(s.res.ai.level) : "…"}
                  {s.res?.ai.confidence != null && ` (conf. ${s.res.ai.confidence.toFixed(2)})`}
                </div>
                {r && (
                  <div className="small">
                    <span className={`pill ${r.status}`}>{r.status.replace("_", " ")}</span> {r.statusReason}
                  </div>
                )}
                {s.confirmed && (
                  <div className="small">
                    ↳ Team leader confirmed <strong>{formatLevel(s.confirmed.level)}</strong>
                  </div>
                )}
                {outcome && (
                  <div className="small muted">
                    Alert step ({outcome.mode}): {outcome.summary}
                  </div>
                )}
                {s.res?.provisional?.map((a) => (
                  <div key={a.id} className="notice warn small" style={{ whiteSpace: "pre-wrap" }}>
                    <LevelBadge stage={a.level} /> provisional warning while the reading is checked
                    {"\n"}
                    {a.message}
                  </div>
                ))}
                {outcome?.alerts.map((a) => (
                  <div key={a.id} className={`notice small stage-${a.level}`} style={{ whiteSpace: "pre-wrap" }}>
                    <LevelBadge stage={a.level} /> <span className="pill">{a.kind}</span> sent to {a.recipients} chat(s)
                    {outcome.safetyNet.some((x) => x.id === a.id) ? " by the safety net" : ""}
                    {"\n"}
                    {a.message}
                  </div>
                ))}
                {s.error && <div className="notice error small">{s.error}</div>}
              </div>
            </div>
          </div>
        );
      })}

      {outbox && (
        <div className="card">
          <h2>What was sent</h2>
          <p className="small muted">Messages to the stand-in resident and observer team (most recent first).</p>
          <pre className="log">
            {outbox.length ? outbox.map((m) => `→ ${m.chatId}\n${m.text}`).join("\n\n") : "No messages."}
          </pre>
        </div>
      )}
    </>
  );
}
