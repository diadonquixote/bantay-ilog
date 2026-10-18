"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, useAdminToken } from "@/components/api";
import { LevelBadge } from "@/components/LevelBadge";
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

  return (
    <>
      <h1>Demo: a rising river</h1>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          This sends {DEMO_LEVELS.length} synthetic gauge photos, {STEP_MIN} minutes apart, through the real pipeline for the
          demo station (alert {DEMO_STATION.thresholds.alert} m, alarm {DEMO_STATION.thresholds.alarm} m, critical{" "}
          {DEMO_STATION.thresholds.critical} m). At step 7 the observer types a wrong number, so the reading is held for a team
          member to confirm.
        </p>
        <p className="small muted">
          AI mode: <strong>{aiMode}</strong>
          {aiMode === "mock"
            ? " — without an API key the demo uses the true level of each sample (with a small error) as the AI reading."
            : " — Claude reads each synthetic gauge image for real."}
        </p>
        {adminRequired && (
          <input
            type="password"
            placeholder="Admin token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ maxWidth: 300, marginBottom: "0.5rem" }}
          />
        )}
        <div className="row">
          <button onClick={run} disabled={running}>
            {running ? "Running…" : steps.length ? "Run again" : "Run demo"}
          </button>
          <Link className="button secondary" href="/dashboard?station=demo">
            Open demo dashboard
          </Link>
        </div>
        {error && <div className="notice error">{error}</div>}
      </div>

      {steps.map((s) => {
        const r = s.res?.reading;
        const outcome = s.confirmed?.outcome ?? s.res?.outcome ?? null;
        const final = s.confirmed?.level ?? r?.level ?? null;
        return (
          <div key={s.i} className="card">
            <div className="row" style={{ alignItems: "flex-start", gap: "1rem", flexWrap: "nowrap" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
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
