/** A rectangle as fractions (0–1) of the frame. */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tall, narrow guide box: observers line the gauge board up inside it. */
export const GUIDE_BOX: CropBox = { x: 0.3, y: 0.04, w: 0.4, h: 0.92 };

/** Crop `box` out of `src`, adding a small margin, and scale so the long side is at most `maxSide`. */
export function cropCanvas(src: HTMLCanvasElement, box: CropBox = GUIDE_BOX, maxSide = 1280, margin = 0.04): HTMLCanvasElement {
  const x0 = Math.max(0, box.x - margin) * src.width;
  const y0 = Math.max(0, box.y - margin) * src.height;
  const x1 = Math.min(1, box.x + box.w + margin) * src.width;
  const y1 = Math.min(1, box.y + box.h + margin) * src.height;
  const sw = Math.max(1, x1 - x0);
  const sh = Math.max(1, y1 - y0);
  const scale = Math.min(1, maxSide / Math.max(sw, sh));

  const out = document.createElement("canvas");
  out.width = Math.round(sw * scale);
  out.height = Math.round(sh * scale);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, x0, y0, sw, sh, 0, 0, out.width, out.height);
  return out;
}

/** JPEG data URL, stepping quality down until it fits `maxBytes` (base64 length is ~4/3 of bytes). */
export function toJpegDataUrl(canvas: HTMLCanvasElement, maxBytes = 900_000): string {
  let q = 0.88;
  let url = canvas.toDataURL("image/jpeg", q);
  while (url.length * 0.75 > maxBytes && q > 0.4) {
    q -= 0.1;
    url = canvas.toDataURL("image/jpeg", q);
  }
  return url;
}
