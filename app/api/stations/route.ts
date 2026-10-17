import { Station } from "@/lib/schemas";
import { adminRequired, badRequest, isAdmin } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ stations: await getDb().listStations() });
}

/** Create or update a station (admin). */
export async function POST(req: Request) {
  if (!isAdmin(req)) return adminRequired();
  const parsed = Station.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  if (parsed.data.gaugeMin >= parsed.data.gaugeMax) return badRequest("gaugeMin must be below gaugeMax.");
  const station = await getDb().upsertStation(parsed.data);
  return Response.json({ station });
}
