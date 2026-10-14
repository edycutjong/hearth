"use client";

import { useState } from "react";
import { processorsParagraph } from "@/lib/copy";
import { api, type SpaceInfo } from "./types";

/** Data under the user's control: keep the space, recover it elsewhere, export everything, delete everything. */
export function You({ space, zdrConfirmed, onChanged }: { space: SpaceInfo; zdrConfirmed: boolean; onChanged: () => void }) {
  const [key, setKey] = useState<string | null>(null);
  const [recover, setRecover] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [listing, setListing] = useState<Array<{ prefix: string; count: number }> | null>(null);
  const [busy, setBusy] = useState(false);

  async function exportAll() {
    setExporting("Collecting your files…");
    const r = await api<{ files: Array<{ path: string; url: string }>; inline: Array<{ path: string; text: string }>; error?: string }>("/api/export");
    if (!r.ok) {
      setExporting(r.data.error ?? "Export failed.");
      return;
    }
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    let n = 0;
    for (const f of r.data.files) {
      n += 1;
      setExporting(`Fetching ${n} of ${r.data.files.length} straight from storage…`);
      const res = await fetch(f.url);
      if (res.ok) zip.file(f.path, await res.arrayBuffer());
    }
    for (const f of r.data.inline) zip.file(f.path, f.text);
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `hearth-export-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setExporting(`Ready: ${(blob.size / 1000).toFixed(1)} KB, built in this browser — the files never passed through our server.`);
  }

  return (
    <div className="stack">
      <h2>Your space</h2>
      <div className="card stack">
        <p>
          {space.kept ? (
            <strong>Kept: no expiry. Delete it whenever you like.</strong>
          ) : (
            <strong>Anonymous: deleted automatically in {space.daysLeft ?? 7} day{space.daysLeft === 1 ? "" : "s"}.</strong>
          )}
        </p>
        {!space.kept ? (
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await api<{ recoveryKey?: string; error?: string }>("/api/space/keep", { method: "POST" });
              setBusy(false);
              if (r.data.recoveryKey) setKey(r.data.recoveryKey);
              else setMsg(r.data.error ?? "Could not keep the space.");
              onChanged();
            }}
          >
            Keep my space
          </button>
        ) : null}
        {key ? (
          <div className="stack">
            <p>Your recovery key — shown once. Write it down to open this space on another device:</p>
            <p className="key">{key}</p>
          </div>
        ) : null}
        <form
          style={{ display: "flex", gap: 8 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await api<{ ok?: boolean; error?: string }>("/api/space/recover", { method: "POST", body: JSON.stringify({ key: recover }) });
            setMsg(r.ok ? "Opened. Reloading…" : (r.data.error ?? "That key does not open a space."));
            if (r.ok) window.location.reload();
          }}
        >
          <input type="text" value={recover} onChange={(e) => setRecover(e.target.value)} placeholder="Recovery key from another device" aria-label="Recovery key" />
          <button className="btn">Open</button>
        </form>
        {msg ? <p className="note-hint">{msg}</p> : null}
      </div>
      <div className="card stack">
        <strong>Export everything</strong>
        <p style={{ fontSize: 15 }}>The tokens, transcripts, memory, a calendar file, any originals you kept, and decode.py — which plays the voices with the open NanoCodec model, without Hearth.</p>
        <button className="btn" onClick={() => void exportAll()} disabled={!!exporting && exporting.startsWith("Fetching")}>
          Export (built in your browser)
        </button>
        {exporting ? <p className="note-hint" aria-live="polite">{exporting}</p> : null}
      </div>
      <div className="card ink stack">
        <strong>Delete everything</strong>
        <p style={{ fontSize: 15 }}>Every key under your three storage prefixes is deleted, then listed again so you can see them empty. Your calendar feed stops working.</p>
        {!confirm ? (
          <button className="btn" onClick={() => setConfirm(true)}>Delete everything…</button>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const r = await api<{ listings?: Array<{ prefix: string; count: number }>; deleted?: number; error?: string }>("/api/delete-all", { method: "POST", body: JSON.stringify({ confirm: "delete" }) });
                setBusy(false);
                setConfirm(false);
                if (r.data.listings) setListing(r.data.listings);
                else setMsg(r.data.error ?? "Delete failed.");
                onChanged();
              }}
            >
              {busy ? "Deleting…" : "Yes, delete it all"}
            </button>
            <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        )}
        {listing ? (
          <div className="listing" aria-live="polite">
            {listing.map((l) => (
              <div key={l.prefix}>
                {l.prefix} → {l.count} object{l.count === 1 ? "" : "s"}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <details className="card">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Who processes what, and for how long</summary>
        <ul style={{ marginTop: 10, paddingLeft: 18 }} className="stack">
          {processorsParagraph(zdrConfirmed).map((line) => (
            <li key={line} style={{ fontSize: 15 }}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
