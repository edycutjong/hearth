"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Status } from "./types";

/** Polls the space's status: every 5 s while anything is in flight, every 30 s otherwise. */
export function useStatus(enabled: boolean) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const r = await api<Partial<Status> & { error?: string }>("/api/status");
    if (!r.ok) {
      setError(r.status === 0 ? "No connection — Hearth will try again." : (r.data.error ?? `status: HTTP ${r.status}`));
      return null;
    }
    if (!("space" in r.data) || (r.data.space && !r.data.flags)) {
      setError("Hearth could not read your space just now; it will try again.");
      return null;
    }
    if (r.data.space === null) {
      // The space was deleted (or expired): there is nothing to show but that.
      setGone(true);
      setStatus(null);
      return null;
    }
    setGone(false);
    setError(null);
    setStatus(r.data as Status);
    return r.data as Status;
  }, []);

  useEffect(() => {
    if (!enabled || gone) return;
    let alive = true;
    const loop = async () => {
      let busy = true; // after a failure, try again soon
      try {
        const s = await refresh();
        busy =
          !s ||
          s.jobs.some((j) => ["queued", "dispatched", "running", "finalizing"].includes(j.state)) ||
          s.notes.some((n) => n.status === "processing" || n.status === "queued" || (n.status === "kept" && (n.memory === "pending" || n.memory === "running")));
      } finally {
        if (alive) timer.current = setTimeout(loop, busy ? 5000 : 30000);
      }
    };
    void loop();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, gone, refresh]);

  return { status, error, gone, refresh };
}
