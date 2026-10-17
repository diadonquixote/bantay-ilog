import { LEVELS } from "@/lib/levels";
import type { LevelKey } from "@/lib/schemas";

export function LevelBadge({ stage, tl = false }: { stage: LevelKey | null; tl?: boolean }) {
  if (!stage) return <span className="pill">No reading</span>;
  const info = LEVELS[stage];
  return <span className={`badge ${stage}`}>{tl ? info.labelTl : info.label}</span>;
}
