import { after } from "next/server";
import { FrameRequest } from "@/lib/schemas";
import { aiMode } from "@/lib/server/ai";
import { adminRequired, badRequest, isAdmin, tooManyRequests } from "@/lib/server/auth";
import { getDb, newId } from "@/lib/server/db";
import { getNotifier } from "@/lib/server/notify";
import { afterAccepted, identityKey, ingestReading } from "@/lib/server/pipeline";
import { clientKey, rateLimit } from "@/lib/server/rateLimit";
import { parseDataUrl, readGauge } from "@/lib/server/readGauge";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** One photo per 20 s per device, with a little burst room for a flushed offline queue. */
const LIMIT = { limit: 6, windowSec: 120 };

/**
 * POST a gauge photo (already cropped on the device) plus the observer's own
 * reading. The photo is stored, read by the AI, checked against the observer,
 * and — if accepted — handed to the alert agent.
 *
 * ?wait=1 waits for the alert agent and returns its outcome; otherwise the
 * agent runs after the response is sent so field phones aren't kept waiting.
 */
export async function POST(req: Request) {
  const wait = rateLimit(`frame:${clientKey(req)}`, LIMIT);
  if (wait != null) return tooManyRequests(wait);

  const parsed = FrameRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const body = parsed.data;

  const db = getDb();
  const station = await db.getStation(body.stationId);
  if (!station) return Response.json({ error: `Unknown station "${body.stationId}".` }, { status: 404 });

  if (body.clientId) {
    const existing = await db.findReadingByClientId(station.id, body.clientId);
    if (existing) return Response.json({ reading: existing, duplicate: true, outcome: null, aiMode: aiMode() });
  }

  let image: ReturnType<typeof parseDataUrl>;
  try {
    image = parseDataUrl(body.image);
  } catch (e) {
    return badRequest((e as Error).message);
  }
  const bytes = Buffer.from(image.base64, "base64");
  if (bytes.length > 5_000_000) return badRequest("Image is larger than 5 MB; crop or compress it first.");

  const ext = image.mediaType === "image/png" ? "png" : "jpg";
  const key = `${station.id}/${new Date().toISOString().slice(0, 10)}/${newId()}.${ext}`;
  const photoPath = await db.savePhoto(key, bytes, image.mediaType);

  const ai = await readGauge({ imageDataUrl: body.image, station, demoLevel: body.demoLevel });
  const notifier = getNotifier(db);
  const waitForAgent = new URL(req.url).searchParams.get("wait") === "1";

  const result = await ingestReading(
    db,
    notifier,
    {
      station,
      source: station.id === "demo" ? "demo" : "photo",
      ai,
      observerLevel: body.observerLevel ?? null,
      observerName: body.observerName ?? null,
      observerKey: identityKey(body.observerName ?? null),
      takenAt: body.takenAt,
      clientId: body.clientId,
      photoPath,
      photoBytes: bytes,
    },
    { runAgent: waitForAgent },
  );

  if (!waitForAgent && !result.duplicate && result.reading.status === "accepted") {
    after(() =>
      afterAccepted(db, notifier, station, result.reading).catch((e) => console.error("[frame] alert step failed", e)),
    );
  }

  return Response.json({ ...result, ai, aiMode: aiMode() }, { status: result.duplicate ? 200 : 201 });
}

/**
 * GET ?readingId=… returns the stored photo for that reading.
 *
 * Gauge photos show a riverbank, often with houses and people in frame, so they
 * are for the team that confirms readings, not for anyone with the link.
 */
export async function GET(req: Request) {
  if (!isAdmin(req)) return adminRequired();
  const id = new URL(req.url).searchParams.get("readingId");
  if (!id) return badRequest("readingId is required");
  const db = getDb();
  const reading = await db.getReading(id);
  if (!reading?.photoPath) return Response.json({ error: "No photo for this reading." }, { status: 404 });
  const photo = await db.loadPhoto(reading.photoPath);
  if (!photo) return Response.json({ error: "Photo missing from storage." }, { status: 404 });
  return new Response(new Uint8Array(photo.bytes), {
    headers: { "content-type": photo.contentType, "cache-control": "private, no-store" },
  });
}
