import { ManualReadingRequest } from "@/lib/schemas";
import { aiMode, MODEL } from "@/lib/server/ai";
import { adminRequired, badRequest, isAdmin } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { getNotifier } from "@/lib/server/notify";
import { ingestReading } from "@/lib/server/pipeline";
import { getStationStatus } from "@/lib/server/status";

export const dynamic = "force-dynamic";

const maskChat = (id: string) => (id.startsWith("demo-") || id.length <= 4 ? id : `…${id.slice(-4)}`);

/**
 * GET ?stationId=…&hours=24 → readings, trend, alerts, advisory for the dashboard.
 * GET with no stationId → station list and which services are live.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const db = getDb();
  const stations = await db.listStations();
  const system = {
    ai: aiMode(),
    model: aiMode() === "live" ? MODEL : null,
    db: db.kind,
    telegram: process.env.TELEGRAM_BOT_TOKEN ? "live" : "log",
    adminTokenRequired: Boolean(process.env.ADMIN_TOKEN),
  };

  const stationId = url.searchParams.get("stationId");
  if (!stationId) return Response.json({ stations, system });

  const station = stations.find((s) => s.id === stationId);
  if (!station) return Response.json({ error: `Unknown station "${stationId}".` }, { status: 404 });

  const hours = Math.min(Math.max(Number(url.searchParams.get("hours")) || 24, 1), 24 * 14);
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const [readings, alerts, advisory, status, subscribers] = await Promise.all([
    db.listReadings(stationId, { sinceIso: since, limit: 500 }),
    db.listAlerts(stationId, since),
    db.latestAdvisory(),
    getStationStatus(db, station),
    db.listSubscribers(stationId),
  ]);

  // The outbox shows what would have been sent; only admins see it.
  const outbox = isAdmin(req)
    ? (await db.listOutbox(30)).map((m) => ({ ...m, chatId: maskChat(m.chatId) }))
    : null;

  return Response.json({
    station,
    stations,
    system,
    status: {
      latest: status.latest,
      stage: status.stage,
      trend: status.trend,
      pendingConfirmations: status.pendingConfirmations,
      pendingHighest: status.pendingHighest,
    },
    readings,
    alerts,
    advisory,
    subscriberCount: subscribers.length,
    outbox,
  });
}

/** A typed-in reading with no photo. It always needs a second person to confirm. */
export async function POST(req: Request) {
  const parsed = ManualReadingRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const db = getDb();
  const station = await db.getStation(parsed.data.stationId);
  if (!station) return Response.json({ error: "Unknown station." }, { status: 404 });

  const result = await ingestReading(db, getNotifier(db), {
    station,
    source: "manual",
    ai: null,
    observerLevel: parsed.data.level,
    observerName: parsed.data.observerName,
    takenAt: parsed.data.takenAt,
    clientId: parsed.data.clientId,
  });
  return Response.json(result, { status: result.duplicate ? 200 : 201 });
}

/** DELETE ?stationId=demo clears the demo station. Other stations can't be wiped from the API. */
export async function DELETE(req: Request) {
  const stationId = new URL(req.url).searchParams.get("stationId");
  if (stationId !== "demo") return badRequest("Only the demo station can be reset.");
  if (!isAdmin(req)) return adminRequired();
  const db = getDb();
  await db.resetStation("demo");
  // A stand-in resident so the demo shows what subscribers would receive.
  await db.addSubscriber({ chatId: "demo-resident", stationId: "demo", name: "Demo resident", createdAt: new Date().toISOString() });
  return Response.json({ ok: true });
}
