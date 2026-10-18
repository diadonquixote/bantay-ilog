import type { Reading, Station } from "../schemas";

/**
 * Anything served to someone without the admin token is redacted here.
 *
 * Observer team chat ids are credentials: knowing one is enough to look like
 * the team in a forged Telegram update. Observer names and gauge photos are
 * personal data about volunteers and their neighbourhood.
 */
export function publicStation(s: Station): Station {
  return { ...s, teamChatIds: [] };
}

/** "Kagawad Reyes" -> "Kagawad R." ; "tg:12345" -> "observer". */
export function maskName(name: string | null): string | null {
  if (!name) return null;
  if (name.startsWith("tg:")) return "observer";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.length > 1 ? `${parts[0]} ${parts[1][0].toUpperCase()}.` : parts[0];
}

export function publicReading(r: Reading): Reading {
  return {
    ...r,
    observerName: maskName(r.observerName),
    observerKey: null,
    confirmedBy: maskName(r.confirmedBy),
    confirmedByKey: null,
    // No photo link for the public: the photo route checks the token too.
    photoPath: null,
    photoHash: null,
  };
}

export function publicView<T extends { station?: Station; stations?: Station[]; readings?: Reading[] }>(
  data: T,
  isAdmin: boolean,
): T {
  if (isAdmin) return data;
  return {
    ...data,
    ...(data.station ? { station: publicStation(data.station) } : {}),
    ...(data.stations ? { stations: data.stations.map(publicStation) } : {}),
    ...(data.readings ? { readings: data.readings.map(publicReading) } : {}),
  };
}
