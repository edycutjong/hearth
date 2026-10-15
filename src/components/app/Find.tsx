"use client";

import { useState } from "react";
import type { Hit } from "@/lib/search";
import { mmss, shortDay } from "../format";
import { api } from "./types";

/** Search returns real segments, never generated text. Click one to hear it. */
export function Find({ scope = "space", onOpen, placeholder = "knee · पैसे · 5000" }: { scope?: "space" | "sample"; onOpen: (note: string, t0: number, t1: number) => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [terms, setTerms] = useState<string[]>([]);
  const [lexical, setLexical] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim()) {
      setHint("Type a word first — in Hindi or English.");
      return;
    }
    setHint(null);
    setBusy(true);
    const r = await api<{ hits: Hit[]; terms: string[]; lexicalOnly: boolean; error?: string }>("/api/search", { method: "POST", body: JSON.stringify({ q, scope }) });
    setBusy(false);
    if (!r.ok) {
      setHint(r.status === 0 ? "Search failed: no connection. Try again in a moment." : `Search failed (${r.data.error ?? `HTTP ${r.status}`}). Try again.`);
      return; // the results already shown stay
    }
    setHits(r.data.hits ?? []);
    setTerms(r.data.terms ?? []);
    setLexical(Boolean(r.data.lexicalOnly));
  }
  return (
    <div className="stack">
      <form onSubmit={run} style={{ display: "flex", gap: 8 }} role="search">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label="Search the notes" />
        <button className="btn primary" disabled={busy}>{busy ? "Finding…" : "Find"}</button>
      </form>
      {hint ? <p className="note-hint" role="status">{hint}</p> : null}
      <div aria-live="polite" className="stack">
      {hits ? (
        <>
          <p className="note-hint">
            {lexical ? "Searched as typed (no expansion)." : `Nemotron 3 Super expanded it to: ${terms.join(" · ")}`} Ranked by code (BM25) over the Hindi and its translation.
          </p>
          {hits.length ? (
            hits.map((h) => (
              <button key={`${h.note}-${h.segment}`} className="seg match" onClick={() => onOpen(h.note, h.t0, h.t1)}>
                <span className="t">{mmss(h.t0)}</span>
                <span>
                  <span className="hi" lang="hi" style={{ display: "block" }}>{h.text}</span>
                  <span className="en" style={{ display: "block" }}>
                    {h.label ? `${h.label}${h.anchor ? ` · ${shortDay(h.anchor)}` : ""} · ` : ""}
                    {h.gloss ?? ""}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <p className="muted">No segment matches.</p>
          )}
        </>
      ) : null}
      </div>
    </div>
  );
}
