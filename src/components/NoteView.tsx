"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readHctCodes } from "@/lib/hct";
import type { MemoryItem, TranscriptDoc } from "@/lib/memory";
import { Coupon } from "./Coupon";
import { TokenStrip } from "./TokenStrip";
import { kb, mmss } from "./format";

export interface Fact {
  label: string;
  value: string;
}

type Which = "original" | "kept";

/**
 * One note folded in three like an inland letter: the note (token strip + A/B), what was said (segments with
 * their machine translation), and what was kept (coupons). Both players share one timeline.
 */
export function NoteView({
  title,
  subtitle,
  hctUrl,
  originalUrl,
  keptUrl,
  originalLabel = "Original",
  keptLabel = "Kept · NanoCodec",
  transcript,
  glosses = {},
  items = [],
  facts = [],
  highlight = [],
  seek = null,
  gateLine,
  onDecode,
  keptNote,
  calendarHref,
  stepDone,
  onSeekUsed,
  memoryState,
  memoryError,
}: {
  title: string;
  subtitle: string;
  hctUrl: string | null;
  originalUrl: string | null;
  keptUrl: string | null;
  originalLabel?: string;
  keptLabel?: string;
  transcript: TranscriptDoc | null;
  glosses?: Record<string, string>;
  items?: MemoryItem[];
  facts?: Fact[];
  highlight?: number[];
  seek?: { t0: number; t1: number; nonce: number } | null;
  gateLine?: string | null;
  onDecode?: (() => void) | null;
  keptNote?: string | null;
  calendarHref?: (item: MemoryItem) => string | null;
  stepDone?: (step: "original" | "kept" | "stamp") => void;
  /** Called once a search jump has played, so a later remount never replays it. */
  onSeekUsed?: () => void;
  /** Where this note's memory pass stands (absent for the published sample, which is done). */
  memoryState?: "pending" | "running" | "done" | "paused" | "skipped" | "failed";
  memoryError?: string;
}) {
  const [codes, setCodes] = useState<Uint16Array[] | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);
  const [playing, setPlaying] = useState<Which | null>(null);
  const [t, setT] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const originalRef = useRef<HTMLAudioElement>(null);
  const keptRef = useRef<HTMLAudioElement>(null);
  const el = useCallback((which: Which) => (which === "original" ? originalRef.current : keptRef.current), []);
  const stopAt = useRef<number | null>(null);
  const seconds = transcript?.duration_s ?? 0;

  useEffect(() => {
    let alive = true;
    setCodes(null);
    if (!hctUrl) return;
    fetch(hctUrl)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`tokens: HTTP ${r.status}`))))
      .then((buf) => {
        if (!alive) return;
        setBytes(buf.byteLength);
        setCodes(readHctCodes(buf).codes);
      })
      .catch((e: unknown) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [hctUrl]);

  const stopAll = useCallback(() => {
    for (const k of ["original", "kept"] as const) el(k)?.pause();
    setPlaying(null);
    stopAt.current = null;
  }, [el]);

  const play = useCallback(
    (which: Which, from?: number, to?: number) => {
      const a = el(which);
      if (!a) return;
      for (const k of ["original", "kept"] as const) if (k !== which) el(k)?.pause();
      if (from !== undefined) a.currentTime = from;
      stopAt.current = to ?? null;
      void a.play().then(
        () => {
          setPlaying(which);
          stepDone?.(which);
        },
        (e: unknown) => setError(`playback: ${String(e)}`),
      );
    },
    [el, stepDone],
  );

  // A search jump plays once per request (its nonce), never again on re-render.
  const lastSeek = useRef<number | null>(null);
  useEffect(() => {
    if (!seek || lastSeek.current === seek.nonce) return;
    lastSeek.current = seek.nonce;
    play(keptUrl ? "kept" : "original", seek.t0, seek.t1);
    onSeekUsed?.();
  }, [seek, keptUrl, play, onSeekUsed]);

  const onTime = (which: Which) => () => {
    const a = el(which);
    if (!a || playing !== which) return;
    setT(a.currentTime);
    if (stopAt.current !== null && a.currentTime >= stopAt.current) {
      a.pause();
      setPlaying(null);
      stopAt.current = null;
    }
  };

  // Whatever stops a player — its end, a pause, a new source — the buttons and the playhead follow it.
  const stopped = (which: Which) => () => setPlaying((p) => (p === which ? null : p));

  const quoted = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const it of items) for (const s of it.segments) m.set(s, [...(m.get(s) ?? []), it.quote]);
    return m;
  }, [items]);

  const playSeg = (t0: number, t1: number) => play(keptUrl ? "kept" : "original", t0, t1);
  const current = t ?? 0;

  return (
    <div className="fold3">
      <section aria-label="The note">
        <h2>{title}</h2>
        <div className="data-hint">{subtitle}</div>
        <TokenStrip
          codes={codes}
          seconds={seconds}
          playhead={playing ? current : null}
          onSeek={(s) => play(playing ?? (keptUrl ? "kept" : "original"), s)}
          label={codes ? `Stored tokens: ${codes[0]?.length ?? 0} frames × 13 codebooks` : "Tokens loading"}
          marks={items.filter((i) => i.due && i.state === "open").map((i) => ({ t: i.t0 }))}
        />
        <div className="strip-axis">
          <span>0:00</span>
          <span>{codes ? `${codes[0]?.length ?? 0} frames × 13 codebooks${bytes ? ` · ${kb(bytes)}` : ""}` : "tokens…"}</span>
          <span>{mmss(seconds)}</span>
        </div>
        <div className="ab">
          <button className="btn" disabled={!originalUrl} onClick={() => (playing === "original" ? stopAll() : play("original", playing ? current : undefined))} aria-pressed={playing === "original"}>
            {playing === "original" ? "❚❚" : "▶"} {originalLabel}
          </button>
          <button className="btn primary" disabled={!keptUrl} onClick={() => (playing === "kept" ? stopAll() : play("kept", playing ? current : undefined))} aria-pressed={playing === "kept"}>
            {playing === "kept" ? "❚❚" : "▶"} {keptLabel}
          </button>
        </div>
        {!keptUrl && onDecode ? (
          <p className="note-hint" style={{ marginTop: 8 }}>
            The 24-hour playback copy has expired. <button className="linkish" onClick={onDecode}>Decode it from the tokens on Nebius</button>
          </p>
        ) : null}
        {keptNote ? <p className="note-hint" style={{ marginTop: 8 }}>{keptNote}</p> : null}
        {originalUrl ? (
          <audio ref={originalRef} src={originalUrl} preload="metadata" onTimeUpdate={onTime("original")} onEnded={stopped("original")} onPause={stopped("original")} onEmptied={stopped("original")} />
        ) : null}
        {keptUrl ? <audio ref={keptRef} src={keptUrl} preload="metadata" onTimeUpdate={onTime("kept")} onEnded={stopped("kept")} onPause={stopped("kept")} onEmptied={stopped("kept")} /> : null}
        {facts.length ? (
          <div className="facts">
            {facts.map((f) => (
              <div key={f.label}>
                <span>{f.label}</span>
                <span>{f.value}</span>
              </div>
            ))}
          </div>
        ) : null}
        {error ? <p className="error" style={{ marginTop: 10 }}>{error}</p> : null}
      </section>
      <div className="crease" aria-hidden="true" />
      <section aria-label="What was said">
        <h3>{Object.keys(glosses).length ? "What was said · Hindi, then machine translation" : "What was said · as transcribed"}</h3>
        {transcript?.segments.length ? (
          transcript.segments.map((s) => (
            <button
              key={s.i}
              className={`seg${highlight.includes(s.i) ? " match" : ""}${playing && current >= s.t0 && current < s.t1 ? " playing" : ""}`}
              onClick={() => playSeg(s.t0, s.t1)}
              title={`Play from ${mmss(s.t0)}`}
            >
              <span className="t">{mmss(s.t0)}</span>
              <span>
                <span className="hi" lang="hi" style={{ display: "block" }}>
                  <Quoted text={s.text} quotes={quoted.get(s.i) ?? []} />
                </span>
                {glosses[String(s.i)] ? <span className="en" style={{ display: "block" }}>{glosses[String(s.i)]}</span> : null}
              </span>
            </button>
          ))
        ) : (
          <p className="muted">The transcript appears when the note is kept.</p>
        )}
      </section>
      <div className="crease" aria-hidden="true" />
      <section aria-label="Kept" className="stack">
        <h3 style={{ marginTop: 0 }}>Kept · quoted as transcribed</h3>
        {items.length ? (
          items.map((it) => (
            <div key={it.id} onClick={() => stepDone?.("stamp")}>
              <Coupon item={it} gloss={glosses[String(it.segments[0])]} onPlay={playSeg} calendarHref={calendarHref?.(it) ?? null} strike />
            </div>
          ))
        ) : (
          <p className="muted">{emptyKept(memoryState, memoryError)}</p>
        )}
        {gateLine ? <p className="gate">{gateLine}</p> : null}
      </section>
    </div>
  );
}

/** What the Kept column says when it holds no coupon — never a gate result for gates that did not run. */
function emptyKept(state: string | undefined, error: string | undefined): string {
  if (state === "paused") return "Reminders are paused for this space: nothing has been sent to Token Factory. Opt in on the Kept tab and this note is read for promises.";
  if (state === "skipped") return error ? `Not read for promises: ${error}.` : "Not read for promises: reminders are Hindi-only in v1.";
  if (state === "pending" || state === "running") return "Reading the transcript for promises…";
  if (state === "failed") return `Could not read the transcript for promises${error ? `: ${error}` : ""}.`;
  return "No promise or ask in this note passed the gates.";
}

/** Underline the quoted spans of kept items inside a segment's text. */
function Quoted({ text, quotes }: { text: string; quotes: string[] }) {
  if (!quotes.length) return <>{text}</>;
  const q = quotes.find((x) => text.includes(x));
  if (!q) return <>{text}</>;
  const i = text.indexOf(q);
  return (
    <>
      {text.slice(0, i)}
      <span className="q">{q}</span>
      {text.slice(i + q.length)}
    </>
  );
}
