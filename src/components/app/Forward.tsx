"use client";

import { useRef, useState } from "react";
import { readChatZip, uploadsFor, type ChatAudio } from "@/lib/chatzip";
import { anchorFromFilename } from "@/lib/dates";
import { audioExt } from "@/lib/keys";
import { kb, mmss } from "../format";
import { api } from "./types";

interface Picked extends ChatAudio {
  blob: Blob;
  seconds: number | null;
}

const LABELS = ["Maa", "Papa", "Me"];
const MAX_NOTE_S = 300;

function duration(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
    a.src = url;
  });
}

/**
 * Forward: pick voice notes (or a WhatsApp "export chat" zip, read here in the browser), give the sender a label,
 * upload straight to Object Storage with presigned PUTs, and keep them with one Nebius Job.
 */
export function Forward({ onKept, maxSeconds = MAX_NOTE_S, code }: { onKept: () => void; maxSeconds?: number; code?: string }) {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [senders, setSenders] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [batchLabel, setBatchLabel] = useState("Maa");
  const [custom, setCustom] = useState("");
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function add(files: FileList | File[]) {
    setError(null);
    const next: Picked[] = [];
    const found: string[] = [];
    for (const f of Array.from(files)) {
      if (/\.zip$/i.test(f.name)) {
        try {
          const z = await readChatZip(f);
          found.push(...z.senders);
          for (const a of z.audios) next.push({ ...a, seconds: await duration(a.blob) });
        } catch {
          setError(`"${f.name}" could not be read as a chat export.`);
        }
      } else if (audioExt(f.name)) {
        next.push({ name: f.name, size: f.size, anchor: anchorFromFilename(f.name), sender: null, blob: f, seconds: await duration(f) });
      } else {
        setError(`"${f.name}" isn't a voice note.`);
      }
    }
    setPicked((p) => [...p, ...next].slice(0, 20));
    if (found.length) setSenders((s) => [...new Set([...s, ...found])]);
  }

  const tooLong = picked.filter((p) => p.seconds !== null && p.seconds > maxSeconds + 0.5);
  const labelFor = (sender: string | null) => (sender ? labels[sender] || "Family" : batchLabel === "custom" ? custom.trim() || "Family" : batchLabel);

  async function keep() {
    setError(null);
    const keepList = picked.filter((p) => !tooLong.includes(p));
    if (!keepList.length) return;
    setBusy("Asking for upload slots…");
    const specs = uploadsFor(keepList, labelFor);
    const slots = await api<{ notes?: Array<{ id: string; putUrl: string; headers: Record<string, string> }>; error?: string }>("/api/notes", {
      method: "POST",
      body: JSON.stringify({ files: specs }),
    });
    if (!slots.ok || !slots.data.notes) {
      setBusy(null);
      setError(slots.data.error ?? "Could not start the upload.");
      return;
    }
    const ids: string[] = [];
    for (const [i, slot] of slots.data.notes.entries()) {
      setBusy(`Uploading ${i + 1} of ${slots.data.notes.length} straight to Nebius Object Storage…`);
      const res = await fetch(slot.putUrl, { method: "PUT", headers: slot.headers, body: keepList[i]?.blob });
      if (!res.ok) {
        setBusy(null);
        setError(`Upload of "${keepList[i]?.name}" failed (HTTP ${res.status}).`);
        return;
      }
      ids.push(slot.id);
    }
    setBusy("Queueing one Nebius Job for these notes…");
    const k = await api<{ error?: string; job?: string }>("/api/keep", { method: "POST", body: JSON.stringify({ notes: ids, code }) });
    setBusy(null);
    if (!k.ok) {
      setError(k.data.error ?? "Could not keep the notes.");
      return;
    }
    setPicked([]);
    setSenders([]);
    onKept();
  }

  return (
    <div className="stack">
      <div
        className={`drop${over ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void add(e.dataTransfer.files);
        }}
      >
        <p style={{ fontWeight: 600 }}>Forward this week&apos;s voice notes</p>
        <p className="muted" style={{ fontSize: 15 }}>
          .opus · .m4a · .ogg · .mp3 · .wav, up to {Math.round(maxSeconds / 60)} min each — or a WhatsApp “export chat” .zip (read here; its text never leaves this device)
        </p>
        <button className="btn" style={{ marginTop: 12 }} onClick={() => input.current?.click()}>
          Choose files
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept="audio/*,.opus,.ogg,.m4a,.mp3,.wav,.aac,.amr,.zip"
          className="sr"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            if (e.target.files) void add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {picked.length ? (
        <div className="card stack">
          {senders.length ? (
            <div>
              <h3 style={{ marginTop: 0 }}>Who is speaking? (a label, never the contact name, is all that is sent)</h3>
              {senders.map((s, i) => (
                <div key={s} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                  <span className="note-hint">sender {i + 1}</span>
                  <div className="labels">
                    {LABELS.map((l) => (
                      <button key={l} aria-pressed={labels[s] === l} onClick={() => setLabels((x) => ({ ...x, [s]: l }))}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div>
              <h3 style={{ marginTop: 0 }}>Whose voice?</h3>
              <div className="labels">
                {[...LABELS, "custom"].map((l) => (
                  <button key={l} aria-pressed={batchLabel === l} onClick={() => setBatchLabel(l)}>
                    {l === "custom" ? "Other…" : l}
                  </button>
                ))}
              </div>
              {batchLabel === "custom" ? (
                <input type="text" value={custom} maxLength={40} placeholder="e.g. Dadi" onChange={(e) => setCustom(e.target.value)} style={{ marginTop: 8 }} aria-label="Label" />
              ) : null}
            </div>
          )}
          <div>
            {picked.map((p) => (
              <div className="file" key={`${p.name}-${p.size}`}>
                <span className="n">{p.name}</span>
                <span className="d">{p.seconds !== null ? mmss(p.seconds) : "—"} · {kb(p.size)}</span>
                <span className="d">
                  {p.anchor ? `dated ${p.anchor} from its file name` : "dated today (no date in its name)"}
                  {p.seconds !== null && p.seconds > maxSeconds + 0.5 ? ` · over ${Math.round(maxSeconds / 60)} min, will be skipped` : ""}
                </span>
              </div>
            ))}
          </div>
          {error ? <p className="error">{error}</p> : null}
          <button className="btn primary full" disabled={!!busy || picked.length === tooLong.length} onClick={() => void keep()}>
            {busy ?? `Keep ${picked.length - tooLong.length} note${picked.length - tooLong.length === 1 ? "" : "s"}`}
          </button>
          <button className="linkish" onClick={() => setPicked([])} disabled={!!busy}>
            Clear
          </button>
        </div>
      ) : error ? (
        <p className="error">{error}</p>
      ) : null}
    </div>
  );
}
