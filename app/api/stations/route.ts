import { Station } from "@/lib/schemas";
import { adminRequired, badRequest, isAdmin } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { publicStation } from "@/lib/server/redact";

export const dynamic = "force-dynamic";

/** Public list for the capture page. Team chat ids are credentials and are stripped. */
export async function GET(req: Request) {
  const stations = await getDb().listStations();
  return Response.json({ stations: isAdmin(req) ? stations : stations.map(publicStation) });
}

/** Create or update a station (admin). */
export async function POST(req: Request) {
  if (!isAdmin(req)) return adminRequired();
  const parsed = Station.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const s = parsed.data;
  if (s.gaugeMin >= s.gaugeMax) return badRequest("gaugeMin must be below gaugeMax.");
  if (s.thresholds.critical > s.gaugeMax || s.thresholds.alert < s.gaugeMin) {
    return badRequest("Thresholds must sit inside the gauge range.");
  }
  const station = await getDb().upsertStation(s);
  return Response.json({ station });
}
