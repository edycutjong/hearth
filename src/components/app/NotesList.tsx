"use client";

import type { NoteMeta } from "@/lib/pipeline";
import { kb, mmss, pct, shortDay } from "../format";

export function rawLine(n: NoteMeta): string {
  const r = n.raw;
  if (r.state === "deleted") return `original deleted ✓ (raw HEAD ${r.rawHead}, originals HEAD ${r.originalHead})`;
  if (r.state === "grace") return `original kept to compare until ${r.deleteAfter?.slice(0, 16).replace("T", " ")} UTC`;
  if (r.state === "kept_original") return r.reason ?? "original kept";
  return n.status === "kept" ? "original present" : "uploaded";
}

/** The space's notes, oldest week first, each with what is stored and what happened to its original. */
export function NotesList({ notes, onOpen }: { notes: NoteMeta[]; onOpen: (id: string) => void }) {
  if (!notes.length) return <p className="muted">No notes yet. Forward a few above.</p>;
  return (
    <div className="stack">
      {[...notes].reverse().map((n) => (
        <button key={n.id} className="card" style={{ width: "100%", textAlign: "left", display: "grid", gap: 4 }} onClick={() => onOpen(n.id)} disabled={n.status !== "kept"}>
          <span style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <span className="display" style={{ fontSize: 24 }}>
              {n.label} · {shortDay(n.anchor)}
            </span>
            <span className="chip">{n.status === "kept" ? "kept" : n.status}</span>
          </span>
          {n.kept ? (
            <span className="note-hint">
              {mmss(n.kept.audioS)} of voice kept in {kb(n.kept.bytesHct)} · upload was {kb(n.kept.inputBytes)} · ASR agreement after the round trip{" "}
              {pct(1 - n.kept.driftNote)} {n.kept.driftPass ? "(passes the gate)" : "(below the gate)"}
            </span>
          ) : (
            <span className="note-hint">{n.name}</span>
          )}
          <span className="note-hint">{rawLine(n)}{n.memory === "paused" ? " · reminders paused" : n.memory === "pending" ? " · remembering…" : ""}</span>
          {n.error ? <span className="note-hint">⚠ {n.error}</span> : null}
        </button>
      ))}
    </div>
  );
}
