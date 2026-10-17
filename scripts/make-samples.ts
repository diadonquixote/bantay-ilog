/**
 * Regenerate the synthetic gauge images in public/samples and the alarm sound in public/audio.
 *   npm run samples
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEMO_LEVELS, gaugeSvg, sampleName } from "../lib/gaugeSvg";

const samplesDir = path.join(process.cwd(), "public", "samples");
mkdirSync(samplesDir, { recursive: true });
for (const level of DEMO_LEVELS) {
  writeFileSync(path.join(samplesDir, sampleName(level)), gaugeSvg(level));
}
console.log(`wrote ${DEMO_LEVELS.length} samples to ${samplesDir}`);

/** Two-tone siren as 16-bit mono PCM WAV. */
function alarmWav(seconds = 2.4, rate = 22050): Buffer {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const freq = Math.floor(t / 0.3) % 2 === 0 ? 880 : 660;
    phase += (2 * Math.PI * freq) / rate;
    const env = Math.min(1, t / 0.02, (seconds - t) / 0.05);
    data.writeInt16LE(Math.round(Math.sin(phase) * 0.6 * env * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const audioDir = path.join(process.cwd(), "public", "audio");
mkdirSync(audioDir, { recursive: true });
writeFileSync(path.join(audioDir, "alarm.wav"), alarmWav());
console.log(`wrote ${path.join(audioDir, "alarm.wav")}`);
