"use client";

import { useEffect, useState } from "react";
import type { JobRecord, NoteMeta } from "@/lib/pipeline";
import { mmss } from "../format";

const ORDER = ["queued", "created", "PROVISIONING", "STARTING", "IMAGE_PULLING", "RUNNING", "done"] as const;

function stageOf(job: JobRecord): number {
  if (job.state === "done" || job.state === "failed") return 6;
  if (job.state === "queued") return 0;
  const i = ORDER.indexOf((job.nebiusState ?? "created") as (typeof ORDER)[number]);
  return i < 1 ? 1 : i;
}

/** A Job's progress: the queue, the Nebius Job and its lifecycle, then validation. Real states, real ids. */
export function Keeping({
  job,
  notes,
  queuePos,
  eta,
}: {
  job: JobRecord;
  notes: NoteMeta[];
  queuePos: number | null;
  eta?: { p50: number; p95: number; runs: number } | null;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = stageOf(job);
  const elapsed = (now - new Date(job.created).getTime()) / 1000;
  const rows: Array<[string, number]> = [
    [job.state === "queued" && queuePos ? `Queued · position ${queuePos} (one Hearth Job at a time; the region is shared)` : "Queued", 0],
    [job.nebiusId ? `Nebius Serverless Job ${job.nebiusId} created` : "Nebius Serverless Job", 1],
    ["Provisioning a cpu-d3 VM · 4 vCPU · 16 GB", 2],
    ["Starting the container", 3],
    ["Pulling the image", 4],
    ["ASR (hi-IN) → NanoCodec → decode → ASR again", 5],
    ["Tokens validated (sha256) · kept", 6],
  ];
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <strong>
          Keeping {job.notes.length} note{job.notes.length === 1 ? "" : "s"}
        </strong>
        <span className="data-hint">{mmss(elapsed)} elapsed · job {job.job}</span>
      </div>
      {eta ? (
        <p className="note-hint" style={{ marginTop: 6 }}>
          Measured on this deployment: about {(eta.p50 / 60).toFixed(1)} min from upload to kept (median of {eta.runs} runs) — most of
          it is Nebius starting a CPU machine and loading the two models.
        </p>
      ) : null}
      <div style={{ marginTop: 8 }} aria-live="polite">
        {rows.map(([label, i]) => (
          <div key={i} className={`stage ${i < s ? "done" : i === s ? "run" : "wait"}`}>
            <span className="dot" />
            <span>{label}</span>
            <span className="tm">{i < s ? "✓" : ""}</span>
          </div>
        ))}
      </div>
      {job.history.length ? (
        <details style={{ marginTop: 8 }}>
          <summary className="note-hint" style={{ cursor: "pointer" }}>What happened ({job.history.length})</summary>
          <ul style={{ paddingLeft: 18, marginTop: 6 }}>
            {job.history.map((h) => (
              <li key={`${h.at}${h.event}`} className="data-hint">
                {h.at.slice(11, 19)} UTC · {h.event}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {notes.some((n) => n.error) ? <p className="error" style={{ marginTop: 8 }}>{notes.find((n) => n.error)?.error}</p> : null}
    </div>
  );
}
