"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Status } from "./types";

/** Polls the space's status: every 5 s while anything is in flight, every 30 s otherwise. */
export function useStatus(enabled: boolean) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const r = await api<Status & { error?: string }>("/api/status");
    if (!r.ok) {
      setError(r.data.error ?? `status: HTTP ${r.status}`);
      return null;
    }
    setError(null);
    setStatus(r.data);
    return r.data;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const loop = async () => {
      const s = await refresh();
      if (!alive) return;
      const busy =
        !!s &&
        (s.jobs.some((j) => ["queued", "dispatched", "running", "finalizing"].includes(j.state)) ||
          s.notes.some((n) => n.status === "processing" || n.status === "queued" || (n.status === "kept" && n.memory === "pending")));
      timer.current = setTimeout(loop, busy ? 5000 : 30000);
    };
    void loop();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, refresh]);

  return { status, error, refresh };
}
