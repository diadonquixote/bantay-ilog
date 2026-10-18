"use client";

import { useEffect, useRef, useState } from "react";
import { useNow } from "./hooks";
import { LEVELS } from "@/lib/levels";
import type { Reading, Station } from "@/lib/schemas";

const PAD = { l: 44, r: 20, t: 14, b: 30 };

function fmtTime(ms: number) {
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" }).format(ms);
}

/** Water level over time with the three alarm thresholds drawn as bands. */
export function LevelChart({ station, readings, hours }: { station: Station; readings: Reading[]; hours: number }) {
  // Draw at the container's real pixel width so text stays 11px on phones instead of shrinking.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(760);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W < 500 ? 240 : 300;
  // The chart is only drawn in the browser, after data has loaded, so the clock is always set.
  const now = useNow(60_000) ?? 0;
  const accepted = readings
    .filter((r) => r.status === "accepted" && r.level != null)
    .map((r) => ({ t: Date.parse(r.takenAt), v: r.level! }))
    .sort((a, b) => a.t - b.t);
  const pending = readings
    .filter((r) => r.status === "needs_confirmation")
    .map((r) => ({ t: Date.parse(r.takenAt), v: r.observerLevel ?? r.aiLevel }))
    .filter((p): p is { t: number; v: number } => p.v != null);

  const t0 = Math.min(now - hours * 3_600_000, ...accepted.map((p) => p.t));
  const t1 = now;
  const th = station.thresholds;
  const values = [...accepted, ...pending].map((p) => p.v);
  const lo = Math.floor(Math.min(th.alert - 1, ...values));
  const hi = Math.ceil(Math.max(th.critical + 0.5, ...values));

  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);

  const bands = [
    { from: th.alert, to: th.alarm, color: LEVELS.alert.color },
    { from: th.alarm, to: th.critical, color: LEVELS.alarm.color },
    { from: th.critical, to: hi, color: LEVELS.critical.color },
  ];
  const yTicks: number[] = [];
  const step = hi - lo > 8 ? 2 : hi - lo > 4 ? 1 : 0.5;
  for (let v = lo; v <= hi + 1e-9; v += step) yTicks.push(Math.round(v * 10) / 10);
  const nx = W < 500 ? 3 : 5;
  const xTicks = Array.from({ length: nx }, (_, i) => t0 + ((t1 - t0) * i) / (nx - 1));
  const path = accepted.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  return (
    <div className="chart" ref={box}>
      {accepted.length === 0 && (
        <p className="small muted" style={{ margin: "0 0 0.25rem" }}>
          No confirmed readings in this period.
        </p>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Water level chart for ${station.name}`}>
        {bands.map((b) => (
          <rect
            key={b.from}
            x={PAD.l}
            width={W - PAD.l - PAD.r}
            y={y(b.to)}
            height={Math.max(0, y(b.from) - y(b.to))}
            fill={b.color}
            opacity={0.12}
          />
        ))}
        {[
          { v: th.alert, c: LEVELS.alert.color, ink: "var(--stage-alert-ink)", l: "1st alarm" },
          { v: th.alarm, c: LEVELS.alarm.color, ink: "var(--stage-alarm-ink)", l: "2nd alarm" },
          { v: th.critical, c: LEVELS.critical.color, ink: "var(--stage-critical-ink)", l: "3rd alarm" },
        ].map((t) => (
          <g key={t.l}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t.v)} y2={y(t.v)} stroke={t.c} strokeDasharray="5 4" strokeWidth={1.5} />
            <text x={PAD.l + 6} y={y(t.v) - 4} textAnchor="start" fontSize={12} fill={t.ink} fontWeight={700}>
              {t.l} {t.v} m
            </text>
          </g>
        ))}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="currentColor" opacity={0.08} />
            <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize={12} fill="currentColor" opacity={0.75}>
              {v}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text
            key={t}
            x={x(t)}
            y={H - 8}
            textAnchor={t === t0 ? "start" : t === t1 ? "end" : "middle"}
            fontSize={12}
            fill="currentColor"
            opacity={0.75}
          >
            {fmtTime(t)}
          </text>
        ))}
        <path d={path} fill="none" stroke="var(--water)" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
        {accepted.map((p) => (
          <circle key={`a${p.t}`} cx={x(p.t)} cy={y(p.v)} r={3.5} fill="var(--water)">
            <title>{`${p.v.toFixed(2)} m at ${fmtTime(p.t)}`}</title>
          </circle>
        ))}
        {pending.map((p) => (
          <circle key={`p${p.t}`} cx={x(p.t)} cy={y(p.v)} r={5} fill="none" stroke="var(--stage-alarm)" strokeWidth={2}>
            <title>{`Unconfirmed ${p.v.toFixed(2)} m at ${fmtTime(p.t)}`}</title>
          </circle>
        ))}
      </svg>
      <p className="small muted" style={{ margin: "0.25rem 0 0" }}>
        Blue line: confirmed readings in metres. Orange rings: reports still waiting for confirmation.
      </p>
    </div>
  );
}
