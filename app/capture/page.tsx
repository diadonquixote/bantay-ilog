"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cameraSupported, fileToCanvas, grabFrame, startCamera, stopCamera } from "@/lib/client/camera";
import { checkPhoto, type PhotoCheck } from "@/lib/client/colorCheck";
import { cropCanvas, GUIDE_BOX, toJpegDataUrl } from "@/lib/client/crop";
import { flushQueue, listQueued, newClientId, submitOrQueue } from "@/lib/client/offlineQueue";
import { classify, formatLevel, LEVELS } from "@/lib/levels";
import type { Alert, Reading, Station } from "@/lib/schemas";

interface FrameResponse {
  reading: Reading;
  duplicate: boolean;
  teamNotified: number | null;
  provisional?: Alert[];
  ai: { level: number | null; confidence: number | null; notes: string; mode: string };
}

/** Check a typed level against the gauge; suggest the likely value when a decimal point is missing. */
function checkLevel(text: string, station: Station | undefined): { ok: boolean; message?: string; suggestion?: number } {
  if (!station || text.trim() === "") return { ok: true };
  const v = Number(text.replace(",", "."));
  if (!Number.isFinite(v)) return { ok: false, message: "Enter the level as a number of metres, e.g. 15.40." };
  const lo = station.gaugeMin - 0.5;
  const hi = station.gaugeMax + 0.5;
  if (v >= lo && v <= hi) return { ok: true };
  const suggestion = [10, 100, 1000].map((d) => Math.round((v / d) * 100) / 100).find((c) => c >= lo && c <= hi);
  return {
    ok: false,
    message: `${v} m is outside this gauge (${station.gaugeMin}–${station.gaugeMax} m).`,
    suggestion,
  };
}

type Phase = "camera" | "review" | "sending" | "done";

export default function CapturePage() {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useState("");
  const [observer, setObserver] = useState("");
  const [level, setLevel] = useState("");
  const [phase, setPhase] = useState<Phase>("camera");
  const [camError, setCamError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [check, setCheck] = useState<PhotoCheck | null>(null);
  const [result, setResult] = useState<{ kind: "sent" | "queued" | "error"; text: string; data?: FrameResponse } | null>(null);
  const [queued, setQueued] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [aiMode, setAiMode] = useState<string>("live");
  const [online, setOnline] = useState(true);

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
        setResult({
          kind: r.dropped.length ? "error" : "sent",
          text: `Sent ${r.sent} saved reading(s).${r.dropped.length ? ` ${r.dropped.length} rejected: ${r.dropped.map((d) => d.error).join("; ")}` : ""}`,
        });
      }
    } finally {
      refreshQueue();
    }
  }, [refreshQueue]);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    const back = () => {
      sync();
      flush();
    };
    fetch("/api/stations")
      .then((r) => r.json())
      .then((d: { stations: Station[] }) => {
        const real = d.stations.filter((s) => s.id !== "demo");
        setStations(real);
        let saved = "";
        try {
          saved = localStorage.getItem("bantay-station") ?? "";
          setObserver(localStorage.getItem("bantay-name") ?? "");
        } catch {}
        setStationId(real.find((s) => s.id === saved)?.id ?? real[0]?.id ?? "");
      })
      .catch(() => setCamError("Could not load stations — you may be offline. Saved readings are sent later."));
    fetch("/api/readings")
      .then((r) => r.json())
      .then((d: { system?: { ai: string } }) => d.system && setAiMode(d.system.ai))
      .catch(() => {});
    refreshQueue();
    flush();
    window.addEventListener("online", back);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", back);
      window.removeEventListener("offline", sync);
    };
  }, [flush, refreshQueue]);

  const openCamera = useCallback(async () => {
    if (!video.current) return;
    if (!cameraSupported()) {
      setCamError("Live camera not available in this browser. Use “Choose photo” instead.");
      return;
    }
    try {
      stream.current = await startCamera(video.current);
      setCamError(null);
    } catch (e) {
      setCamError(`Camera unavailable (${(e as Error).name || "error"}). Allow camera access, or use “Choose photo”.`);
    }
  }, []);

  useEffect(() => {
    if (phase === "camera") openCamera();
    return () => {
      stopCamera(stream.current);
      stream.current = null;
    };
  }, [phase, openCamera]);

  const acceptCanvas = (full: HTMLCanvasElement, crop: boolean) => {
    const cropped = crop ? cropCanvas(full, GUIDE_BOX) : cropCanvas(full, { x: 0, y: 0, w: 1, h: 1 }, 1280, 0);
    setCheck(checkPhoto(cropped));
    setPhoto(toJpegDataUrl(cropped));
    setSendError(null);
    setPhase("review");
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
      setCamError("Could not open that image.");
    }
  };

  const station = stations.find((s) => s.id === stationId);
  const blocked = check && !check.ok;
  const levelCheck = checkLevel(level, station);
  // Without a working AI reader the volunteer's own reading is the only number we get.
  const levelMissing = aiMode !== "live" && level.trim() === "";
  const canSend = !!stationId && levelCheck.ok && !levelMissing;

  const send = async () => {
    if (!photo || !canSend) return;
    const lv = level.trim() === "" ? null : Number(level.replace(",", "."));
    try {
      localStorage.setItem("bantay-station", stationId);
      localStorage.setItem("bantay-name", observer);
    } catch {}
    setPhase("sending");
    const payload = {
      clientId: newClientId(),
      stationId,
      image: photo,
      observerLevel: lv,
      observerName: observer.trim() || null,
      takenAt: new Date().toISOString(),
    };
    const r = await submitOrQueue("/api/frame", payload);
    if (r.status === "sent") {
      setResult({ kind: "sent", text: "Reading sent.", data: r.data as FrameResponse });
    } else if (r.status === "queued") {
      setResult({
        kind: "queued",
        text: `No connection (${r.reason}). Saved on this phone and sent automatically when you are back online.`,
      });
    } else {
      // Keep the photo so the volunteer can fix the problem and resend.
      setSendError(r.error);
      setPhase("review");
      return;
    }
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

  const step = phase === "camera" ? 1 : phase === "done" ? 3 : 2;

  return (
    <>
      <h1>Take a gauge reading</h1>
      <p className="muted small" style={{ marginTop: "-0.25rem" }}>
        Kunan ng litrato ang gauge, isulat ang nakikita mong lebel, ipadala.
      </p>

      <div className="steps-bar" aria-hidden>
        <div className={step >= 1 ? "on" : ""} />
        <div className={step >= 2 ? "on" : ""} />
        <div className={step >= 3 ? "on" : ""} />
      </div>

      {!online && (
        <div className="notice warn">
          <strong>You are offline.</strong> You can still take readings — they are saved on this phone and sent
          automatically when the signal comes back.
        </div>
      )}

      {queued > 0 && (
        <div className="notice warn row spread">
          <span>
            {queued} reading(s) saved on this phone, waiting for signal.
          </span>
          <button className="secondary" onClick={flush}>
            Send now
          </button>
        </div>
      )}

      <div className="card">
        <div className="grid">
          <div>
            <label htmlFor="station">Station</label>
            <select id="station" value={stationId} onChange={(e) => setStationId(e.target.value)}>
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
              onChange={(e) => setObserver(e.target.value)}
              placeholder="e.g. Kagawad Reyes"
              autoComplete="name"
            />
            <p className="small muted" style={{ margin: "0.25rem 0 0" }}>
              So a second person can confirm your reading. Shown to your team only.
            </p>
          </div>
        </div>
      </div>

      {phase === "camera" && (
        <div className="card">
          <div className="camera-box">
            <video ref={video} playsInline muted />
            <div
              className="guide"
              style={{
                left: `${GUIDE_BOX.x * 100}%`,
                top: `${GUIDE_BOX.y * 100}%`,
                width: `${GUIDE_BOX.w * 100}%`,
                height: `${GUIDE_BOX.h * 100}%`,
              }}
            >
              <span>Line the gauge up inside the box</span>
            </div>
          </div>
          {camError && <div className="notice warn">{camError}</div>}
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <button className="big" onClick={capture} disabled={!!camError} style={{ flex: 2 }}>
              📷 Capture
            </button>
            <label className="button secondary big" style={{ flex: 1, margin: 0 }}>
              Choose photo
              <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
            </label>
          </div>
          <p className="small muted" style={{ margin: "0.6rem 0 0" }}>
            Make sure the waterline and the nearest painted number are both visible.
          </p>
        </div>
      )}

      {(phase === "review" || phase === "sending") && photo && (
        <div className="card">
          <div className="grid">
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo} alt="Captured gauge" className="shot" />
            </div>
            <div>
              {check?.issues.map((i) => (
                <div key={i.code} className={`notice ${i.severity === "block" ? "error" : "warn"} small`}>
                  {i.message}
                </div>
              ))}
              {check?.ok && check.issues.length === 0 && <div className="notice ok small">Photo looks good.</div>}

              <label htmlFor="level">What level do you read on the gauge? (metres)</label>
              <input
                id="level"
                type="number"
                inputMode="decimal"
                step="0.01"
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                placeholder={station ? `e.g. ${station.thresholds.alert.toFixed(2)}` : "e.g. 15.40"}
                autoFocus
              />
              {!levelCheck.ok && (
                <div className="notice error small">
                  <div className="field-error">{levelCheck.message}</div>
                  {levelCheck.suggestion != null && (
                    <button className="ghost" onClick={() => setLevel(levelCheck.suggestion!.toFixed(2))}>
                      Did you mean {levelCheck.suggestion.toFixed(2)} m?
                    </button>
                  )}
                </div>
              )}
              <p className="small muted" style={{ marginTop: 4 }}>
                {aiMode === "live"
                  ? "Your reading is checked against the AI's. If they don't agree, a team member confirms it."
                  : "Required: the AI reader is off, so your reading goes to a team member to confirm."}
              </p>
              {sendError && <div className="notice error small">Not sent: {sendError}</div>}

              <div className="sticky-actions">
                <div className="row">
                  {blocked ? (
                    <>
                      <button className="big" onClick={reset} disabled={phase === "sending"} style={{ flex: 2 }}>
                        📷 Retake photo
                      </button>
                      <button
                        className="secondary big"
                        onClick={send}
                        disabled={phase === "sending" || !canSend}
                        style={{ flex: 1 }}
                      >
                        {phase === "sending" ? "Sending…" : "Send anyway"}
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="big" onClick={send} disabled={phase === "sending" || !canSend} style={{ flex: 2 }}>
                        {phase === "sending" ? (
                          <>
                            <span className="spinner" aria-hidden /> Sending…
                          </>
                        ) : levelMissing ? (
                          "Enter your reading first"
                        ) : (
                          "Send reading"
                        )}
                      </button>
                      <button className="secondary big" onClick={reset} disabled={phase === "sending"} style={{ flex: 1 }}>
                        Retake
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {phase === "done" && result && (
        <div className="card">
          <div className={`notice ${result.kind === "error" ? "error" : result.kind === "queued" ? "warn" : "ok"}`}>
            {result.text}
          </div>
          {result.data && <ResultSummary data={result.data} station={station} />}
          <button className="big" onClick={reset} style={{ marginTop: "0.75rem" }}>
            Take another reading
          </button>
        </div>
      )}
    </>
  );
}

function ResultSummary({ data, station }: { data: FrameResponse; station?: Station }) {
  const r = data.reading;
  const stage = r.level != null && station ? classify(r.level, station.thresholds) : null;
  return (
    <div>
      <div className="row spread small" style={{ margin: "0.5rem 0" }}>
        <span>
          AI read: <strong>{formatLevel(data.ai.level)}</strong>
          {data.ai.confidence != null && ` (confidence ${data.ai.confidence.toFixed(2)})`}
          {data.ai.mode === "mock" && <span className="muted"> — mock AI mode</span>}
        </span>
        <span>
          Your reading: <strong>{formatLevel(r.observerLevel)}</strong>
        </span>
      </div>
      <p style={{ margin: "0.5rem 0" }}>
        <span className={`pill ${r.status}`}>{r.status.replace("_", " ")}</span>{" "}
        <span className="small muted">{r.statusReason}</span>
      </p>
      {r.status === "needs_confirmation" &&
        (data.teamNotified ? (
          <div className="notice ok small">Sent to {data.teamNotified} team member(s) to confirm.</div>
        ) : (
          <div className="notice warn small">
            <strong>No observer team is set up to confirm this reading.</strong> Call or message your coordinator with
            the level now.
          </div>
        ))}
      {!!data.provisional?.length && (
        <div className="notice warn small">
          Residents were sent a provisional warning while this reading is being confirmed.
        </div>
      )}
      {r.status === "rejected" && (
        <div className="notice error small">
          The photo couldn&apos;t be read and no level was entered. Retake the photo or type the level you see.
        </div>
      )}
      {stage && (
        <div className={`notice stage-${stage}`} style={{ borderLeftColor: LEVELS[stage].color }}>
          <strong>{LEVELS[stage].label}</strong> — {LEVELS[stage].action}
        </div>
      )}
      <p className="small muted">{data.ai.notes}</p>
    </div>
  );
}
