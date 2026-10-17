/**
 * Draws a synthetic E-type river staff gauge with the water at `level` metres.
 * Used for the demo and for sample images; deterministic for a given level.
 */
export function gaugeSvg(level: number, opts: { width?: number; height?: number } = {}): string {
  const W = opts.width ?? 360;
  const H = opts.height ?? 720;
  const above = 1.5; // metres visible above the waterline
  const below = 0.9;
  const pxPerM = H / (above + below);
  const top = level + above;
  const y = (m: number) => (top - m) * pxPerM;

  const boardX = 120;
  const boardW = 120;
  const parts: string[] = [];

  // Concrete pier background with a few weathering streaks.
  parts.push(`<rect width="${W}" height="${H}" fill="#8f969c"/>`);
  for (let i = 0; i < 9; i++) {
    const x = (i * 97 + Math.round(level * 13)) % W;
    parts.push(`<rect x="${x}" y="0" width="${6 + (i % 3) * 4}" height="${H}" fill="#7d848a" opacity="0.35"/>`);
  }

  // Gauge board.
  parts.push(`<rect x="${boardX - 4}" y="0" width="${boardW + 8}" height="${H}" fill="#3b3f43"/>`);
  parts.push(`<rect x="${boardX}" y="0" width="${boardW}" height="${H}" fill="#f8f8f4"/>`);

  const first = Math.floor((level - below) * 20) / 20;
  for (let m = first; m <= top + 0.05; m = Math.round((m + 0.05) * 100) / 100) {
    const cm = Math.round(m * 100);
    const yTop = y(m + 0.05);
    const h = 0.05 * pxPerM;
    // "E" pattern: the spine of each decimetre is solid, prongs every other 5 cm block.
    const dm = Math.floor(cm / 10);
    const isProng = cm % 10 === 0;
    const leftSide = Math.floor(cm / 100) % 2 === 0;
    const spineX = leftSide ? boardX + 8 : boardX + boardW / 2 - 4;
    parts.push(`<rect x="${spineX}" y="${yTop}" width="14" height="${h}" fill="#d62828"/>`);
    if (isProng) parts.push(`<rect x="${spineX}" y="${yTop}" width="${boardW / 2 - 12}" height="${h}" fill="#d62828"/>`);
    if (cm % 10 === 0) {
      parts.push(`<line x1="${boardX}" x2="${boardX + boardW}" y1="${y(m)}" y2="${y(m)}" stroke="#222" stroke-width="1"/>`);
      const d = dm % 10;
      if (d !== 0) {
        parts.push(
          `<text x="${boardX + boardW - 10}" y="${y(m) - 4}" font-family="Arial, sans-serif" font-size="16" text-anchor="end" fill="#222">${d}</text>`,
        );
      }
    }
    if (cm % 100 === 0) {
      parts.push(`<rect x="${boardX}" y="${y(m) - 1.5}" width="${boardW}" height="3" fill="#111"/>`);
      parts.push(
        `<text x="${boardX + boardW - 8}" y="${y(m) - 6}" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="34" text-anchor="end" fill="#d62828">${cm / 100}</text>`,
      );
    }
  }

  // Water: opaque brown river with a gentle wave at the surface.
  const wy = y(level);
  let wave = `M0,${wy}`;
  for (let x = 0; x <= W; x += 20) wave += ` Q${x + 10},${wy + (x % 40 === 0 ? -4 : 4)} ${x + 20},${wy}`;
  wave += ` L${W},${H} L0,${H} Z`;
  parts.push(`<path d="${wave}" fill="#6b5a3e"/>`);
  for (let i = 1; i < 6; i++) {
    parts.push(
      `<path d="M${(i * 53) % W},${wy + i * 22} q20,-4 40,0" stroke="#8a7656" stroke-width="2" fill="none" opacity="0.7"/>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

/** The rising-river scenario used by /demo and the generated samples. */
export const DEMO_LEVELS = [2.1, 2.3, 2.55, 2.85, 3.15, 3.45, 3.8, 4.1];

export const sampleName = (level: number) => `gauge-${level.toFixed(2)}.svg`;
