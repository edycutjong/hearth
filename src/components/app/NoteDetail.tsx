"use client";

import { useCallback, useEffect, useState } from "react";
import { googleTemplateLink } from "@/lib/ics";
import type { MemoryDoc, TranscriptDoc } from "@/lib/memory";
import type { NoteMeta } from "@/lib/pipeline";
import { NoteView } from "../NoteView";
import { kb, mmss, pct, shortDay } from "../format";
import { rawLine } from "./NotesList";
import { api } from "./types";

interface Detail {
  meta: NoteMeta;
  transcript: TranscriptDoc | null;
  urls: { hct: string | null; kept: string | null; original: string | null };
}

/** One kept note: the A/B on its real token strip, its transcript, its coupons, and the proof of its original's fate. */
export function NoteDetail({
  id,
  memory,
  seek,
  onBack,
  onChanged,
  onSeekUsed,
}: {
  id: string;
  memory: MemoryDoc | null;
  seek: { t0: number; t1: number; nonce: number } | null;
  onBack: () => void;
  onChanged: () => void;
  onSeekUsed?: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const load = useCallback(async () => {
    const r = await api<Detail & { error?: string }>(`/api/notes/${id}`);
    if (!r.ok) setError(r.data.error ?? "Could not open the note.");
    else setD(r.data);
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error)
    return (
      <div className="stack">
        <button className="linkish" onClick={onBack}>← All notes</button>
        <p className="error">{error === "not found" ? "This note is not in your space — it may have been deleted, or the link is from another device." : error}</p>
      </div>
    );
  if (!d)
    return (
      <div className="stack">
        <button className="linkish" onClick={onBack}>← All notes</button>
        <p className="muted">Opening the note…</p>
      </div>
    );
  const m = d.meta;
  const items = (memory?.items ?? []).filter((i) => i.note === id);
  const base = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <div className="stack">
      <button className="linkish" onClick={onBack}>← All notes</button>
      <NoteView
        title={`${m.label}`}
        subtitle={`${shortDay(m.anchor)} (${m.anchorSource === "upload" ? "upload date" : "from the file name"}) · ${mmss(m.kept?.audioS ?? 0)} · ${d.transcript?.lang ?? ""}${m.kept?.langDetected && m.kept.langDetected !== d.transcript?.lang ? ` · sounds like ${m.kept.langDetected}` : ""}`}
        hctUrl={d.urls.hct}
        originalUrl={d.urls.original}
        keptUrl={d.urls.kept}
        originalLabel={`Original · ${m.ext}`}
        keptLabel={`Kept · ${kb(m.kept?.bytesHct ?? 0)}`}
        transcript={d.transcript}
        glosses={memory?.glosses[id] ?? {}}
        items={items}
        seek={seek}
        onSeekUsed={onSeekUsed}
        memoryState={m.memory}
        memoryError={m.memoryError}
        calendarHref={(it) => googleTemplateLink(it, base)}
        keptNote="▶ Kept plays NanoCodec's reconstruction of the recording, decoded from the stored tokens on a Nebius Job."
        onDecode={async () => {
          setBusy("Queued a decode-only Nebius Job…");
          const r = await api<{ error?: string }>(`/api/notes/${id}/decode`, { method: "POST" });
          setBusy(r.ok ? "Decoding from the tokens on Nebius; this page refreshes when it is ready." : (r.data.error ?? "Could not decode."));
          onChanged();
        }}
        facts={[
          { label: "Stored for this note", value: `${kb(m.kept?.bytesHct ?? 0)} of codec tokens (upload was ${kb(m.kept?.inputBytes ?? m.size)})` },
          { label: "ASR agreement after the round trip", value: m.kept ? `${pct(1 - m.kept.driftNote)} (gate ≥ 95 %)` : "—" },
          { label: "Original", value: rawLine(m) },
          { label: "Nebius job", value: `${m.nebiusId ?? "—"} · cpu-d3 · 4vcpu-16gb` },
          { label: "sha256 of the tokens", value: m.kept ? `${m.kept.sha256.slice(0, 16)}…` : "—" },
        ]}
        gateLine={memory ? `Proposed ${memory.stats.proposed} · kept ${memory.stats.kept} · dropped by the quote gate ${memory.stats.droppedByQuoteGate} · amounts removed ${memory.stats.amountRemoved} · dates removed ${memory.stats.whenRemoved} (whole space)` : null}
      />
      <div className="card stack">
        <strong>The original upload</strong>
        <p className="note-hint">{rawLine(m)}</p>
        {m.raw.state !== "deleted" && !confirmDelete ? (
          <button className="btn" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
            Delete original now…
          </button>
        ) : null}
        {m.raw.state !== "deleted" && confirmDelete ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="note-hint">Delete the original file? This cannot be undone; the tokens stay.</span>
          <button
            className="btn primary"
            autoFocus
            disabled={!!busy}
            onClick={async () => {
              setConfirmDelete(false);
              setBusy("Deleting, then asking the storage for it again…");
              const r = await api<{ raw?: NoteMeta["raw"]; error?: string }>(`/api/notes/${id}/delete-original`, { method: "POST" });
              setBusy(r.ok ? `Deleted: raw HEAD ${r.data.raw?.rawHead} · originals HEAD ${r.data.raw?.originalHead} at ${r.data.raw?.checkedAt?.slice(11, 19)} UTC` : (r.data.error ?? "Could not delete."));
              await load();
              onChanged();
            }}
          >
            Yes, delete it
          </button>
            <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        ) : null}
        {busy ? <p className="note-hint" aria-live="polite">{busy}</p> : null}
      </div>
    </div>
  );
}
