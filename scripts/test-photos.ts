/**
 * Measure AI gauge-reading accuracy on real photos.
 *
 * Put photos in test-photos/ named with the true level first, e.g.
 *   15.40_sto-nino_morning.jpg   (level 15.40 m at station sto-nino)
 *   3.15_demo.png
 * then run:  npm run test:photos [-- --station sto-nino]
 *
 * Needs ANTHROPIC_API_KEY (each photo is one Claude call).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_STATION, DEMO_STATION } from "../lib/levels";
import { aiMode, MODEL } from "../lib/server/ai";
import { readGauge } from "../lib/server/readGauge";

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);

const dir = path.join(process.cwd(), "test-photos");
const stations = { [DEFAULT_STATION.id]: DEFAULT_STATION, [DEMO_STATION.id]: DEMO_STATION };
const defaultStation = process.argv.includes("--station") ? process.argv[process.argv.indexOf("--station") + 1] : null;
const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

async function main() {
  if (aiMode() !== "live") {
    console.error("ANTHROPIC_API_KEY is not set; this script measures the real model and has nothing to do in mock mode.");
    process.exit(2);
  }
  const files = readdirSync(dir).filter((f) => TYPES[path.extname(f).toLowerCase()] && /^\d+(\.\d+)?_/.test(f));
  if (!files.length) {
    console.error(`No photos in ${dir}. Name them like 15.40_sto-nino_morning.jpg (see test-photos/README.md).`);
    process.exit(2);
  }

  console.log(`Model ${MODEL}, ${files.length} photo(s)\n`);
  const rows: { file: string; truth: number; read: number | null; conf: number | null; err: number | null }[] = [];
  for (const file of files) {
    const [truthStr, stationId] = file.replace(path.extname(file), "").split("_");
    const station = stations[stationId] ?? stations[defaultStation ?? ""] ?? DEFAULT_STATION;
    const truth = Number(truthStr);
    const mediaType = TYPES[path.extname(file).toLowerCase()];
    const dataUrl = `data:${mediaType};base64,${readFileSync(path.join(dir, file)).toString("base64")}`;
    const r = await readGauge({ imageDataUrl: dataUrl, station });
    const err = r.level == null ? null : Math.round((r.level - truth) * 100) / 100;
    rows.push({ file, truth, read: r.level, conf: r.confidence, err });
    console.log(
      `${file.padEnd(40)} truth ${truth.toFixed(2)}  read ${r.level?.toFixed(2) ?? "  —  "}  conf ${r.confidence?.toFixed(2) ?? " — "}  err ${err?.toFixed(2) ?? "—"}  ${r.notes}`,
    );
  }

  const read = rows.filter((r) => r.err != null);
  const mae = read.reduce((a, r) => a + Math.abs(r.err!), 0) / (read.length || 1);
  const within = (tol: number) => read.filter((r) => Math.abs(r.err!) <= tol).length;
  console.log(`\nReadable: ${read.length}/${rows.length}`);
  console.log(`Mean absolute error: ${mae.toFixed(3)} m`);
  console.log(`Within ±0.05 m: ${within(0.05)}/${read.length} · within ±0.10 m: ${within(0.1)}/${read.length}`);
  const confidentWrong = read.filter((r) => (r.conf ?? 0) >= 0.85 && Math.abs(r.err!) > 0.1);
  if (confidentWrong.length) {
    console.log(`⚠ Confident but off by >0.10 m (these would be auto-accepted without an observer reading):`);
    for (const r of confidentWrong) console.log(`   ${r.file}: read ${r.read} vs ${r.truth}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
