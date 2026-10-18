"use client";

import { useEffect, useState } from "react";
import { getAdminToken } from "./api";

/**
 * Gauge photos are team-only: /api/frame needs the admin token, which a plain
 * <img src> can't send. Fetch with the token header and show it from a blob URL.
 */
export function TeamPhoto({ readingId, alt, style }: { readingId: string; alt: string; style?: React.CSSProperties }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    const token = getAdminToken();
    fetch(`/api/frame?readingId=${encodeURIComponent(readingId)}`, {
      headers: token ? { "x-admin-token": token } : {},
    })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [readingId]);

  if (failed) return <span className="small muted">Photo unavailable</span>;
  if (!src) return <span className="skeleton" style={{ display: "block", width: 110, height: 150, ...style }} aria-hidden="true" />;
  return (
    <a href={src} target="_blank" rel="noreferrer" aria-label="Open the full photo">
      <img src={src} alt={alt} style={style} />
    </a>
  );
}
