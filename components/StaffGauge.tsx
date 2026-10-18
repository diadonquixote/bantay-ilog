import { LEVELS } from "@/lib/levels";
import type { Station } from "@/lib/schemas";

type GaugeStation = Pick<Station, "thresholds" | "gaugeMin" | "gaugeMax">;

const STAGE_MARKS = [
  { key: "alert", short: "1st" },
  { key: "alarm", short: "2nd" },
  { key: "critical", short: "3rd" },
] as const;

/**
 * A drawing of the painted staff gauge people already read at the river:
 * red E-marks every 10 cm, metre numbers, the three alarm lines, and the
 * water standing at the latest confirmed level. An unconfirmed report is a
 * dashed line marked "?".
 */
export function StaffGauge({
  station,
  level,
  pending = null,
  height = 260,
  showLabels = true,
}: {
  station: GaugeStation;
  level: number | null;
  pending?: number | null;
  height?: number;
  showLabels?: boolean;
}) {
  const t = station.thresholds;
  const known = [level, pending].filter((v): v is number => v != null);
  const lo = Math.max(station.gaugeMin, Math.floor(Math.min(t.alert - 1.5, ...known.map((v) => v - 0.6))));
  const hi = Math.min(station.gaugeMax, Math.ceil(Math.max(t.critical + 0.8, ...known.map((v) => v + 0.4))));
  const W = showLabels ? 150 : 64;
  const H = height;
  const top = 6;
  const bottom = H - 6;
  const y = (m: number) => top + ((hi - m) / (hi - lo || 1)) * (bottom - top);
  const bx = 8;
  const bw = 46;

  // Simplified painted face: alternating red/white 10 cm blocks on the left,
  // a tick every 10 cm and the metre number on the right. Readable at any size.
  const marks: React.ReactNode[] = [];
  const pxPerM = (bottom - top) / (hi - lo || 1);
  for (let dm = Math.ceil(lo * 10); dm < hi * 10; dm++) {
    const m = dm / 10;
    const h = y(m) - y(m + 0.1);
    if (dm % 2 === 0) marks.push(<rect key={`b${dm}`} x={bx + 3} y={y(m + 0.1)} width={14} height={h} fill="#c8102e" />);
    if (dm % 10 !== 0 && pxPerM >= 40) {
      marks.push(<rect key={`t${dm}`} x={bx + bw - 10} y={y(m) - 0.5} width={7} height={1} fill="#6b7177" />);
    }
  }
  for (let mm = Math.ceil(lo); mm <= hi; mm++) {
    marks.push(<rect key={`l${mm}`} x={bx} y={y(mm) - 1} width={bw} height={2} fill="#1b1b1b" />);
    if (y(mm) - 15 > top) {
      marks.push(
        <text key={`n${mm}`} x={bx + bw - 3} y={y(mm) - 4} textAnchor="end" fontSize={13} fontWeight={800} fill="#c8102e">
          {mm}
        </text>,
      );
    }
  }

  const wy = level != null ? y(Math.max(lo, Math.min(hi, level))) : null;
  let wave = "";
  if (wy != null) {
    wave = `M0,${wy}`;
    for (let x = 0; x < bx + bw + 8; x += 8) wave += ` q4,${x % 16 === 0 ? -2.5 : 2.5} 8,0`;
    wave += ` L${bx + bw + 8},${H} L0,${H} Z`;
  }

  return (
    <svg
      className="staff-gauge"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role="img"
      aria-label={
        level != null
          ? `Gauge showing ${level.toFixed(2)} metres; alarms at ${t.alert}, ${t.alarm} and ${t.critical} metres`
          : `Gauge with no confirmed reading; alarms at ${t.alert}, ${t.alarm} and ${t.critical} metres`
      }
    >
      <rect x={bx - 3} y={0} width={bw + 6} height={H} rx={3} fill="#3b4248" />
      <rect x={bx} y={0} width={bw} height={H} fill="#fbfbf9" />
      {marks}
      {wy != null && (
        <g className="gauge-water">
          <path d={wave} fill="var(--water)" opacity={0.88} />
          <path d={`M0,${wy} L${bx + bw + 8},${wy}`} stroke="var(--water-edge)" strokeWidth={1.5} />
        </g>
      )}
      {STAGE_MARKS.map((s) => {
        const v = t[s.key];
        if (v < lo || v > hi) return null;
        const info = LEVELS[s.key];
        return (
          <g key={s.key}>
            <line x1={bx - 3} x2={bx + bw + 6} y1={y(v)} y2={y(v)} stroke={info.color} strokeWidth={2.5} />
            {showLabels && (
              <text x={bx + bw + 10} y={y(v) + 4} fontSize={12} fontWeight={700} fill={`var(--stage-${s.key}-ink)`}>
                {s.short} · {v} m
              </text>
            )}
          </g>
        );
      })}
      {pending != null && pending >= lo && pending <= hi && (
        <g>
          <line x1={0} x2={bx + bw + 6} y1={y(pending)} y2={y(pending)} stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="4 3" />
          {showLabels && (
            <text x={bx + bw + 10} y={y(pending) + 4} fontSize={12} fontWeight={700} fill="var(--ink)">
              ? {pending.toFixed(2)}
            </text>
          )}
        </g>
      )}
    </svg>
  );
}
