"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { readLocal, useClientValue, useOnline, writeLocal } from "@/components/hooks";
import { cameraSupported, fileToCanvas, grabFrame, startCamera, stopCamera } from "@/lib/client/camera";
import { checkPhoto, type PhotoCheck } from "@/lib/client/colorCheck";
import { cropCanvas, GUIDE_BOX, toUploadDataUrl } from "@/lib/client/crop";
import { flushQueue, listQueued, newClientId, submitOrQueue } from "@/lib/client/offlineQueue";
import { classify, formatLevel, LEVELS } from "@/lib/levels";
import type { Alert, Reading, Station } from "@/lib/schemas";

interface FrameResponse {
  reading: Reading;
  duplicate: boolean;
  teamNotified: number | null;
  /** Warnings sent to residents while a high reading waits for confirmation. */
  provisional?: Alert[];
  ai: { level: number | null; confidence: number | null; notes: string; mode: string };
}

type Phase = "camera" | "review" | "sending" | "done";
type Result = { kind: "sent"; data: FrameResponse } | { kind: "queued"; reason: string };

const STATIONS_KEY = "bantay-stations";

/** Check a typed level against the gauge; suggest the likely value when a decimal point is missing. */
function checkLevel(text: string, station: Station | undefined): { ok: boolean; message?: string; suggestion?: number } {
  if (!station || text.trim() === "") return { ok: true };
  const v = Number(text.replace(",", "."));
  if (!Number.isFinite(v)) return { ok: false, message: "Enter the level as a number of metres, e.g. 15.40." };
  const lo = station.gaugeMin - 0.5;
  const hi = station.gaugeMax + 0.5;
  if (v >= lo && v <= hi) return { ok: true };
  const suggestion = [10, 100, 1000].map((d) => Math.round((v / d) * 100) / 100).find((c) => c >= lo && c <= hi);
  return { ok: false, message: `${v} m is outside this gauge (${station.gaugeMin}–${station.gaugeMax} m).`, suggestion };
}

export default function CapturePage() {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const levelRef = useRef<HTMLInputElement>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useState("");
  // The name typed last time, until the volunteer edits it.
  const savedName = useClientValue(() => readLocal("bantay-name"), "");
  const [observerEdit, setObserver] = useState<string | null>(null);
  const observer = observerEdit ?? savedName;
  const [editingWho, setEditingWho] = useState(false);
  const [level, setLevel] = useState("");
  const [phase, setPhase] = useState<Phase>("camera");
  const [camError, setCamError] = useState<string | null>(null);
  const [camReady, setCamReady] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [check, setCheck] = useState<PhotoCheck | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [queued, setQueued] = useState(0);
  const [flushNote, setFlushNote] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // Until we know the AI reader is on, the volunteer's own number is required.
  const [aiMode, setAiMode] = useState<string>("unknown");
  const online = useOnline();
  const cameraOk = useClientValue(() => cameraSupported(), true);

  const refreshQueue = useCallback(async () => {
    try {
      setQueued((await listQueued()).length);
    } catch {
      setQueued(0);
    }
  }, []);

  const flush = useCallback(async () => {
    try {
      const r = await flushQueue();
      if (r.sent || r.dropped.length) {
        setFlushNote(
          `Sent ${r.sent} saved reading${r.sent === 1 ? "" : "s"}.` +
            (r.dropped.length ? ` ${r.dropped.length} could not be accepted: ${r.dropped.map((d) => d.error).join("; ")}` : ""),
        );
      }
    } finally {
      refreshQueue();
    }
  }, [refreshQueue]);

  useEffect(() => {
    const savedStation = readLocal("bantay-station");
    const savedName = readLocal("bantay-name");
    const apply = (list: Station[]) => {
      setStations(list);
      setStationId(list.find((s) => s.id === savedStation)?.id ?? list[0]?.id ?? "");
      setEditingWho(!savedName || !list.some((s) => s.id === savedStation));
    };
    fetch("/api/stations")
      .then((r) => r.json())
      .then((d: { stations: Station[] }) => {
        const real = d.stations.filter((s) => s.id !== "demo");
        writeLocal(STATIONS_KEY, JSON.stringify(real));
        apply(real);
      })
      .catch(() => {
        // Offline at the river: use the list from the last visit.
        try {
          apply(JSON.parse(readLocal(STATIONS_KEY) || "[]") as Station[]);
        } catch {
          apply([]);
        }
      });
    fetch("/api/readings")
      .then((r) => r.json())
      .then((d: { system?: { ai: string } }) => d.system && setAiMode(d.system.ai))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/set-state-in-effect -- only sets state after reading IndexedDB
    refreshQueue();
    flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [flush, refreshQueue]);

  const openCamera = useCallback(async () => {
    if (!video.current || !cameraSupported()) return;
    try {
      stream.current = await startCamera(video.current);
      setCamError(null);
      setCamReady(true);
    } catch (e) {
      const denied = (e as Error).name === "NotAllowedError";
      setCamError(
        denied
          ? "Camera permission is off. Allow it in your browser settings, or use “Upload a photo”."
          : "The camera couldn't start. Use “Upload a photo” instead.",
      );
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- only sets state once the camera has started
    if (phase === "camera") openCamera();
    return () => {
      stopCamera(stream.current);
      stream.current = null;
    };
  }, [phase, openCamera]);

  const acceptCanvas = (full: HTMLCanvasElement, crop: boolean) => {
    const cropped = crop ? cropCanvas(full, GUIDE_BOX) : cropCanvas(full, { x: 0, y: 0, w: 1, h: 1 }, 1280, 0);
    setCamReady(false);
    setCheck(checkPhoto(cropped));
    setPhoto(toUploadDataUrl(cropped));
    setSendError(null);
    setPhase("review");
    setTimeout(() => levelRef.current?.focus(), 50);
  };

  const capture = () => {
    if (!video.current?.videoWidth) return;
    acceptCanvas(grabFrame(video.current), true);
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      acceptCanvas(await fileToCanvas(file), false);
    } catch {
      setCamError("That file couldn't be opened as a photo.");
    }
  };

  const station = stations.find((s) => s.id === stationId);
  const blocked = check != null && !check.ok;
  const levelCheck = checkLevel(level, station);
  const levelMissing = aiMode !== "live" && level.trim() === "";
  const canSend = phase !== "sending" && !!stationId && levelCheck.ok && !levelMissing;

  const send = async () => {
    if (!photo || !canSend) return;
    const lv = level.trim() === "" ? null : Number(level.replace(",", "."));
    writeLocal("bantay-station", stationId);
    writeLocal("bantay-name", observer.trim());
    setPhase("sending");
    const r = await submitOrQueue("/api/frame", {
      clientId: newClientId(),
      stationId,
      image: photo,
      observerLevel: lv,
      observerName: observer.trim() || null,
      takenAt: new Date().toISOString(),
    });
    if (r.status === "rejected") {
      // Keep the photo so the volunteer can fix the problem and resend.
      setSendError(r.error);
      setPhase("review");
      return;
    }
    setResult(r.status === "sent" ? { kind: "sent", data: r.data as FrameResponse } : { kind: "queued", reason: r.reason });
    setEditingWho(false);
    await refreshQueue();
    setPhase("done");
  };

  const reset = () => {
    setPhoto(null);
    setCheck(null);
    setResult(null);
    setSendError(null);
    setLevel("");
    setPhase("camera");
  };

  const stepIndex = phase === "camera" ? 0 : phase === "done" ? 2 : 1;
  const sendLabel =
    phase === "sending"
      ? "Sending…"
      : levelMissing
          ? "Type the level first"
          : blocked
            ? "Send anyway"
            : "Send reading";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Take a reading</h1>
          <p className="muted">Kunan ng litrato ang gauge at ilagay ang sukat na nakikita mo.</p>
        </div>
      </div>

      <ol className="stepper" aria-label="Progress">
        {["Photo of the gauge", "Your reading", "Sent"].map((label, i) => (
          <li key={label} aria-current={i === stepIndex ? "step" : undefined} className={i < stepIndex ? "done" : undefined}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {!online && (
        <div className="notice warn" role="status">
          <strong>You are offline.</strong> You can still take readings — they are saved on this phone and sent
          automatically when the signal comes back.
        </div>
      )}

      {queued > 0 && (
        <div className="notice warn row" style={{ justifyContent: "space-between" }} role="status">
          <span>
            <strong>{queued}</strong> reading{queued === 1 ? "" : "s"} saved on this phone, waiting for signal.
          </span>
          <button className="secondary" onClick={flush}>
            Try sending now
          </button>
        </div>
      )}
      {flushNote && (
        <div className="notice ok" role="status">
          {flushNote}
        </div>
      )}

      <section className="card" aria-label="Who is reporting">
        {editingWho ? (
          <div className="fields">
            <div>
              <label htmlFor="station">Gauge station</label>
              <select id="station" value={stationId} onChange={(e) => setStationId(e.target.value)}>
                {stations.length === 0 && <option value="">No stations available</option>}
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.river}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="observer">Your name</label>
              <input
                id="observer"
                value={observer}
                autoComplete="name"
                onChange={(e) => setObserver(e.target.value)}
                placeholder="e.g. Kagawad Reyes"
                aria-describedby="observer-hint"
              />
              <p className="hint" id="observer-hint">
                So a second person can confirm your reading. Shown to your team only.
              </p>
            </div>
          </div>
        ) : (
          <div className="who">
            <span>
              Reporting for <strong>{station?.name ?? "—"}</strong>
              {observer ? (
                <>
                  {" "}as <strong>{observer}</strong>
                </>
              ) : (
                <span className="muted"> (no name)</span>
              )}
            </span>
            <button className="ghost" onClick={() => setEditingWho(true)}>
              Change
            </button>
          </div>
        )}
      </section>

      {phase === "camera" && (
        <section className="card" aria-label="Camera">
          <div className="camera-box">
            <video ref={video} playsInline muted aria-label="Camera preview" />
            {camReady && (
              <div
                className="guide"
                style={{
                  left: `${GUIDE_BOX.x * 100}%`,
                  top: `${GUIDE_BOX.y * 100}%`,
                  width: `${GUIDE_BOX.w * 100}%`,
                  height: `${GUIDE_BOX.h * 100}%`,
                }}
              >
                <span>Gauge + waterline here</span>
              </div>
            )}
          </div>
          {(camError || !cameraOk) && (
            <div className="notice warn">
              {cameraOk ? camError : "This browser can't open the camera. Use “Upload a photo” instead."}
            </div>
          )}
          <div className="shutter-row">
            <label className="button secondary" style={{ margin: 0 }}>
              Upload a photo
              <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
            </label>
            <button className="shutter" onClick={capture} disabled={!camReady} aria-label="Take photo" />
            <span className="small muted" style={{ maxWidth: 140, textAlign: "right" }}>
              Keep the waterline and the nearest painted number in the box.
            </span>
          </div>
        </section>
      )}

      {(phase === "review" || phase === "sending") && photo && (
        <section className="card review" aria-label="Check and send">
          <div>
            <img src={photo} alt="The gauge photo you just took" />
            {check?.issues.map((i) => (
              <div key={i.code} className={`notice ${i.severity === "block" ? "error" : "warn"} small`}>
                {i.message}
              </div>
            ))}
            {check?.ok && check.issues.length === 0 && <div className="notice ok small">Photo looks clear.</div>}
          </div>

          <div>
            <label htmlFor="level" style={{ marginTop: 0 }}>
              What level do you see on the gauge?
            </label>
            <div className="level-input">
              <input
                ref={levelRef}
                id="level"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={level}
                aria-invalid={!levelCheck.ok}
                aria-describedby="level-hint"
                onChange={(e) => setLevel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder={station ? station.thresholds.alert.toFixed(2) : "15.40"}
              />
              <span className="unit" aria-hidden="true">
                m
              </span>
            </div>
            {!levelCheck.ok && (
              <div className="notice error small" role="alert">
                {levelCheck.message}{" "}
                {levelCheck.suggestion != null && (
                  <button className="secondary" onClick={() => setLevel(levelCheck.suggestion!.toFixed(2))}>
                    Did you mean {levelCheck.suggestion.toFixed(2)} m?
                  </button>
                )}
              </div>
            )}
            <p className="hint" id="level-hint">
              {aiMode === "live"
                ? "The AI also reads the photo. If your numbers differ, a team member checks before anyone is alerted."
                : "A team member checks your reading before residents are alerted."}
            </p>
            {sendError && (
              <div className="notice error small" role="alert">
                Not sent: {sendError}
              </div>
            )}

            <div className="sticky-actions" style={{ display: "grid", gap: "0.6rem", marginTop: "1rem" }}>
              {blocked ? (
                <>
                  <button className="big" onClick={reset} disabled={phase === "sending"}>
                    Retake photo
                  </button>
                  <button className="secondary" onClick={send} disabled={!canSend}>
                    {sendLabel}
                  </button>
                </>
              ) : (
                <>
                  <button className="big" onClick={send} disabled={!canSend}>
                    {phase === "sending" && <span className="spinner" aria-hidden="true" />}
                    {sendLabel}
                  </button>
                  <button className="secondary" onClick={reset} disabled={phase === "sending"}>
                    Retake photo
                  </button>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {phase === "done" && result && (
        <section className="card" aria-live="polite">
          {result.kind === "queued" ? (
            <ResultHead icon="↥" tone="saved" title="Saved on this phone">
              No signal right now. It will send by itself when you&apos;re back online — you can close this page.
            </ResultHead>
          ) : (
            <ResultSummary data={result.data} station={station} />
          )}
          <div style={{ display: "grid", gap: "0.6rem", marginTop: "1.2rem" }}>
            <button className="big" onClick={reset}>
              Take another reading
            </button>
            <Link className="button secondary" href="/">
              See river status
            </Link>
          </div>
        </section>
      )}
    </>
  );
}

function ResultHead({
  icon,
  tone,
  title,
  children,
}: {
  icon: string;
  tone: "ok" | "wait" | "bad" | "saved";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="result-head">
      <span className={`result-icon ${tone}`} aria-hidden="true">
        {icon}
      </span>
      <div>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <p style={{ margin: "0.2rem 0 0" }}>{children}</p>
      </div>
    </div>
  );
}

function ResultSummary({ data, station }: { data: FrameResponse; station?: Station }) {
  const r = data.reading;
  const stage = r.level != null && station ? classify(r.level, station.thresholds) : null;

  return (
    <>
      {r.status === "accepted" && (
        <ResultHead icon="✓" tone="ok" title={`Recorded: ${formatLevel(r.level)}`}>
          Salamat! Your reading is confirmed and on the river status page.
        </ResultHead>
      )}
      {r.status === "needs_confirmation" && (
        <ResultHead icon="…" tone="wait" title="Sent — waiting for a team member">
          {data.teamNotified
            ? `${data.teamNotified} team member${data.teamNotified === 1 ? " was" : "s were"} asked to confirm it.`
            : "Nobody is set up to confirm readings for this station."}
        </ResultHead>
      )}
      {r.status === "rejected" && (
        <ResultHead icon="!" tone="bad" title="Not recorded">
          The photo couldn&apos;t be read and no level was typed. Retake the photo or type the level you see.
        </ResultHead>
      )}

      {r.status === "needs_confirmation" && !data.teamNotified && (
        <div className="notice warn">
          <strong>Call or message your coordinator now</strong> with the level you saw ({formatLevel(r.observerLevel)}).
        </div>
      )}

      {!!data.provisional?.length && (
        <div className="notice warn">
          Residents were sent a <strong>provisional warning</strong> while this reading is being confirmed.
        </div>
      )}

      {stage && stage !== "normal" && (
        <div className="notice" style={{ borderColor: LEVELS[stage].color }}>
          <strong>{LEVELS[stage].label}.</strong> {LEVELS[stage].action}
        </div>
      )}

      <dl className="small" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.2rem 1rem", margin: "1rem 0 0" }}>
        <dt className="muted">You saw</dt>
        <dd className="data" style={{ margin: 0 }}>
          {formatLevel(r.observerLevel)}
        </dd>
        <dt className="muted">AI read</dt>
        <dd style={{ margin: 0 }}>
          <span className="data">{formatLevel(data.ai.level)}</span>
          {data.ai.confidence != null && <span className="muted"> ({Math.round(data.ai.confidence * 100)}% sure)</span>}
          {data.ai.mode === "mock" && <span className="muted"> — AI reader is off</span>}
        </dd>
        <dt className="muted">Why</dt>
        <dd style={{ margin: 0 }}>{r.statusReason}</dd>
      </dl>
      {data.ai.notes && <p className="hint">{data.ai.notes}</p>}
    </>
  );
}
