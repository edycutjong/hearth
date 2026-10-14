"use client";

import { useState } from "react";
import { ASK_FIRST_HI, CONSENT, CONSENT_VERSION, processorsParagraph } from "@/lib/copy";
import { api } from "./types";

/** Before any upload: everyone whose voice is in the notes has agreed. Hindi first, English second. */
export function Consent({ zdrConfirmed, onDone }: { zdrConfirmed: boolean; onDone: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const [deleteOriginals, setDeleteOriginals] = useState(true);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="narrow stack">
      <h1>Keep the voice notes from home.</h1>
      <p className="lead">
        Forward a parent&apos;s Hindi voice notes. Hearth keeps each voice as NVIDIA NanoCodec tokens with a searchable Hindi
        transcript, and every promise or ask in it becomes a reminder quoted word for word.
      </p>
      <div className="card ink stack">
        <label className="check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            <span lang="hi" style={{ display: "block", fontWeight: 600, fontSize: 19 }}>{CONSENT.hi}</span>
            <span style={{ display: "block", marginTop: 4 }}>{CONSENT.en}</span>
          </span>
        </label>
        <p className="note-hint">Hindi wording awaiting a native speaker&apos;s review.</p>
        <div>
          <button
            className="btn small"
            onClick={() => {
              void navigator.clipboard.writeText(ASK_FIRST_HI).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied ✓" : "Copy a message to ask first (Hindi)"}
          </button>
          <p className="note-hint" style={{ marginTop: 6 }} lang="hi">{ASK_FIRST_HI}</p>
          <p className="note-hint">Hearth never sends anything itself; paste it into your chat.</p>
        </div>
      </div>
      <label className="check card">
        <input type="checkbox" checked={deleteOriginals} onChange={(e) => setDeleteOriginals(e.target.checked)} />
        <span>
          <strong>Delete originals after a verified round trip</strong>
          <span className="muted" style={{ display: "block", fontSize: 15 }}>
            The original is kept 24 hours so you can compare, then deleted — and Hearth shows you the storage answering 404.
            Off: originals stay in your space and count as stored audio.
          </span>
        </span>
      </label>
      <details className="card">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Who processes what, and for how long</summary>
        <ul style={{ marginTop: 10, paddingLeft: 18 }} className="stack">
          {processorsParagraph(zdrConfirmed).map((line) => (
            <li key={line} style={{ fontSize: 15 }}>{line}</li>
          ))}
        </ul>
      </details>
      {error ? <p className="error">{error}</p> : null}
      <button
        className="btn primary full"
        disabled={!agreed || busy}
        onClick={async () => {
          setBusy(true);
          const r = await api<{ error?: string }>("/api/consent", { method: "POST", body: JSON.stringify({ agreed, deleteOriginals, textVersion: CONSENT_VERSION }) });
          setBusy(false);
          if (!r.ok) setError(r.data.error ?? "Could not save the consent.");
          else onDone();
        }}
      >
        {busy ? "Saving…" : "Continue"}
      </button>
    </div>
  );
}
