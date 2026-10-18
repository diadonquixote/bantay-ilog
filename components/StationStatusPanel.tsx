import { LEVELS } from "@/lib/levels";
import type { LevelKey, Reading, Station } from "@/lib/schemas";
import { stageStyle } from "./LevelBadge";
import { StaffGauge } from "./StaffGauge";
import { TimeAgo } from "./TimeAgo";

export interface PanelTrend {
  ratePerHour: number | null;
  direction: string;
  eta: { key: LevelKey; value: number; minutes: number } | null;
}

export interface PanelPending {
  level: number;
  stage: LevelKey;
  takenAt: string;
}

/** Matches STALE_AFTER_MIN in lib/server/status.ts: older readings aren't the river right now. */
export const DEFAULT_STALE_MIN = 90;

export function unconfirmedNewer(latest: Reading | null, pending: PanelPending | null): PanelPending | null {
  if (!pending || pending.stage === "normal") return null;
  if (latest && Date.parse(pending.takenAt) <= Date.parse(latest.takenAt)) return null;
  return pending;
}

export function TrendText({ trend }: { trend: PanelTrend }) {
  if (trend.ratePerHour == null) return <span>Trend: not enough recent readings</span>;
  const arrow = trend.direction === "rising" ? "▲" : trend.direction === "falling" ? "▼" : "▬";
  const word = trend.direction === "rising" ? "Rising" : trend.direction === "falling" ? "Falling" : "Steady";
  return (
    <span className="trend">
      {arrow} {word} <span className="data">{trend.ratePerHour >= 0 ? "+" : ""}{trend.ratePerHour.toFixed(2)} m/h</span>
    </span>
  );
}

/**
 * The answer to "do I need to do anything?" for one station: level, stage in
 * English and Tagalog, the action, freshness, trend, and the gauge drawing.
 */
export function StationStatusPanel({
  station,
  latest,
  stage,
  trend,
  pending,
  ageMinutes = null,
  staleAfterMin = DEFAULT_STALE_MIN,
  headingLevel = 2,
  children,
}: {
  station: Station;
  latest: Reading | null;
  stage: LevelKey | null;
  trend: PanelTrend;
  pending: PanelPending | null;
  /** Minutes since the latest confirmed reading (from the server). */
  ageMinutes?: number | null;
  staleAfterMin?: number;
  headingLevel?: 1 | 2;
  children?: React.ReactNode;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const info = stage ? LEVELS[stage] : null;
  const unconfirmed = unconfirmedNewer(latest, pending);
  const stale = ageMinutes != null && ageMinutes > staleAfterMin;

  return (
    <section className="card status-panel" style={stageStyle(stage)}>
      <p className="eyebrow">
        {station.river}
        {station.location ? ` · ${station.location}` : ""}
      </p>
      <Heading style={{ margin: 0 }}>{station.name}</Heading>

      {/* The number and the gauge drawing side by side; everything else full width below. */}
      <div className="sp-main">
        <div>
          {latest?.level != null && info ? (
            <>
              <div className="big-number">
                {latest.level.toFixed(2)}
                <small>m</small>
              </div>
              <p className="stage-line">{info.label}</p>
              <p className="stage-line-tl">{info.labelTl}</p>
            </>
          ) : (
            <>
              <p className="stage-line muted" style={{ fontSize: "1.4rem", marginTop: 0 }}>
                No reading yet
              </p>
              <p className="muted" style={{ margin: "0.3rem 0 0" }}>
                Wala pang kumpirmadong sukat.
              </p>
            </>
          )}
        </div>
        <StaffGauge station={station} level={latest?.level ?? null} pending={unconfirmed?.level ?? null} height={220} />
      </div>

      {info && (
        <p className="action">
          <strong>{info.action}</strong>
          <br />
          <span className="muted">{info.actionTl}</span>
        </p>
      )}

      {stale && latest && (
        <div className="notice warn">
          <strong>
            Last reading was <TimeAgo iso={latest.takenAt} />.
          </strong>{" "}
          This may not be the river right now. Huling sukat ay luma na.
        </div>
      )}

      {unconfirmed && (
        <div className="notice error">
          <strong>
            Unconfirmed report: {unconfirmed.level.toFixed(2)} m ({LEVELS[unconfirmed.stage].label})
          </strong>
          <p>
            Sent <TimeAgo iso={unconfirmed.takenAt} />. A team member is checking it; alerts go out once it is confirmed.
          </p>
        </div>
      )}

      <div className="status-meta">
        {latest ? (
          <span>
            Updated{" "}
            <strong>
              <TimeAgo iso={latest.takenAt} staleAfterMin={staleAfterMin} />
            </strong>
          </span>
        ) : (
          <span>The first confirmed reading will appear here.</span>
        )}
        {latest && <TrendText trend={trend} />}
        {trend.eta && (
          <span>
            <strong>{LEVELS[trend.eta.key].label}</strong> ({trend.eta.value} m) in ~
            <strong className="data">{trend.eta.minutes} min</strong> at this rate
          </span>
        )}
      </div>
      {children}
    </section>
  );
}
