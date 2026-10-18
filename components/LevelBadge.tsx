import { LEVELS } from "@/lib/levels";
import type { LevelKey } from "@/lib/schemas";

export function LevelBadge({ stage, tl = false }: { stage: LevelKey | null; tl?: boolean }) {
  if (!stage) return <span className="badge none">No reading</span>;
  const info = LEVELS[stage];
  return <span className={`badge ${stage}`}>{tl ? info.labelTl : info.label}</span>;
}

/** CSS variables that colour a panel by flood stage. */
export function stageStyle(stage: LevelKey | null): React.CSSProperties {
  if (!stage) return {};
  return { "--stage-color": `var(--stage-${stage})`, "--stage-ink": `var(--stage-${stage}-ink)` } as React.CSSProperties;
}
