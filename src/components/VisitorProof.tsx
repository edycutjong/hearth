"use client";

import { useEffect, useState } from "react";
import type { JobRecord, NoteMeta } from "@/lib/pipeline";
import { kb, mmss, pct } from "./format";

interface ProofResp {
  visitor?: { job: JobRecord | null; notes: NoteMeta[]; memory: { stats: Record<string, number>; calls: Array<{ requestId: string | null; model: string; ms: number; at: string; error?: string }> } | null };
}

/** The visitor's own last run, read live from their space. */
export function VisitorProof() {
  const [p, setP] = useState<ProofResp | null>(null);
  useEffect(() => {
    void fetch("/api/proof", { cache: "no-store" }).then((r) => r.json()).then(setP).catch(() => setP({}));
  }, []);
  const v = p?.visitor;
  if (!p) return <p className="muted">Reading your space…</p>;
  if (!v?.job) return <p className="muted">You have not kept a note yet. Your own run will appear here, with its Job ID, timings and hashes.</p>;
  return (
    <div className="stack">
      <table className="plain">
        <tbody>
          <tr><th>Hearth job</th><td className="num">{v.job.job} · {v.job.state}</td></tr>
          <tr><th>Nebius job</th><td className="num">{v.job.nebiusId ?? "—"} · cpu-d3 · {v.job.preset}</td></tr>
          <tr><th>Created → finished</th><td className="num">{v.job.created} → {v.job.finished ?? "…"}</td></tr>
        </tbody>
      </table>
      <table className="plain">
        <thead>
          <tr><th>Note</th><th>Audio</th><th>Tokens</th><th>sha256</th><th>Agreement</th><th>Original</th></tr>
        </thead>
        <tbody>
          {v.notes.map((n) => (
            <tr key={n.id}>
              <td>{n.label} · {n.anchor}</td>
              <td className="num">{n.kept ? mmss(n.kept.audioS) : "—"}</td>
              <td className="num">{n.kept ? kb(n.kept.bytesHct) : "—"}</td>
              <td className="num">{n.kept ? `${n.kept.sha256.slice(0, 12)}…` : "—"}</td>
              <td className="num">{n.kept ? pct(1 - n.kept.driftNote) : "—"}</td>
              <td className="num">{n.raw.state}{n.raw.rawHead ? ` · raw HEAD ${n.raw.rawHead} · originals HEAD ${n.raw.originalHead}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {v.memory ? (
        <table className="plain">
          <thead>
            <tr><th>Token Factory request</th><th>Model</th><th>Latency</th></tr>
          </thead>
          <tbody>
            {v.memory.calls.map((c) => (
              <tr key={`${c.at}${c.requestId}`}>
                <td className="num">{c.requestId ?? "—"}{c.error ? ` · ${c.error}` : ""}</td>
                <td className="num">{c.model}</td>
                <td className="num">{(c.ms / 1000).toFixed(1)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
