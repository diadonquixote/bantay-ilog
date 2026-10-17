export interface PhotoIssue {
  code: "dark" | "bright" | "blurry" | "low_contrast" | "glare" | "no_gauge_colors";
  severity: "block" | "warn";
  message: string;
}

export interface PhotoCheck {
  ok: boolean;
  issues: PhotoIssue[];
  metrics: { brightness: number; contrast: number; sharpness: number; glare: number; gaugeColor: number };
}

/** Pure analysis over RGBA pixels, so it can be unit-tested without a DOM. */
export function analyzePixels(data: Uint8ClampedArray, width: number, height: number): PhotoCheck {
  const n = width * height;
  const gray = new Float32Array(n);
  let sum = 0;
  let glare = 0;
  let gaugeColor = 0;

  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = y;
    sum += y;
    if (y > 250) glare++;
    // Staff gauges are painted red/white or yellow/black: count strongly warm, saturated pixels.
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat > 0.45 && max > 90 && r === max && b < g + 20) gaugeColor++;
  }
  const brightness = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (gray[i] - brightness) ** 2;
  const contrast = Math.sqrt(varSum / n);

  // Variance of the Laplacian: low values mean few sharp edges, i.e. blur.
  let lapSum = 0;
  let lapSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      lapSum += lap;
      lapSq += lap * lap;
      count++;
    }
  }
  const lapMean = count ? lapSum / count : 0;
  const sharpness = count ? lapSq / count - lapMean ** 2 : 0;

  const metrics = {
    brightness: Math.round(brightness),
    contrast: Math.round(contrast),
    sharpness: Math.round(sharpness),
    glare: Math.round((glare / n) * 1000) / 1000,
    gaugeColor: Math.round((gaugeColor / n) * 1000) / 1000,
  };

  const issues: PhotoIssue[] = [];
  if (brightness < 35) issues.push({ code: "dark", severity: "block", message: "Too dark — use a flashlight or wait for more light. / Masyadong madilim." });
  else if (brightness > 235) issues.push({ code: "bright", severity: "block", message: "Overexposed — avoid pointing at the sun. / Sobrang liwanag." });
  if (sharpness < 12) issues.push({ code: "blurry", severity: "block", message: "Blurry — hold the phone steady and tap to focus. / Malabo ang litrato." });
  else if (sharpness < 40) issues.push({ code: "blurry", severity: "warn", message: "A little blurry — retake if you can. / Medyo malabo." });
  if (contrast < 18) issues.push({ code: "low_contrast", severity: "warn", message: "Low contrast (fog or rain on the lens?). Wipe the lens. / Punasan ang lente." });
  if (metrics.glare > 0.15) issues.push({ code: "glare", severity: "warn", message: "Strong glare on the water or gauge — change your angle. / May silaw." });
  if (metrics.gaugeColor < 0.01) issues.push({ code: "no_gauge_colors", severity: "warn", message: "No painted gauge colours found — is the gauge inside the box? / Nasa loob ba ng kahon ang gauge?" });

  // A dark or blown-out photo also looks blurry, flat and colourless; only report the cause.
  const exposure = issues.find((i) => i.code === "dark" || i.code === "bright");
  const shown = exposure ? [exposure] : issues;
  return { ok: !shown.some((i) => i.severity === "block"), issues: shown, metrics };
}

/** Check a canvas, downscaled to ~320px wide for speed. */
export function checkPhoto(canvas: HTMLCanvasElement): PhotoCheck {
  const scale = Math.min(1, 320 / canvas.width);
  const w = Math.max(3, Math.round(canvas.width * scale));
  const h = Math.max(3, Math.round(canvas.height * scale));
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const ctx = small.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, h);
  return analyzePixels(ctx.getImageData(0, 0, w, h).data, w, h);
}
