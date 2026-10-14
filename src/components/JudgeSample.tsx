"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { FLEURS_ATTRIBUTION, FLEURS_LABEL, GATE_LIMIT, KEPT_LABEL } from "@/lib/copy";
import type { SampleDoc } from "@/lib/sample";
import { Find } from "./app/Find";
import { NoteView } from "./NoteView";
import { kb, mmss, pct } from "./format";

/**
 * The judge path: no account, no Job, no cap. Everything here was produced by a real Nebius Job and is
 * committed with the app, so it opens instantly and stays up through judging.
 */
export function JudgeSample({ sample, bench }: { sample: SampleDoc; bench: BenchSummary | null }) {
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [noteId, setNoteId] = useState<string | null>(sample.ab?.note ?? sample.notes[0]?.id ?? null);
  const [seek, setSeek] = useState<{ t0: number; t1: number; nonce: number } | null>(null);
  const note = useMemo(() => sample.notes.find((n) => n.id === noteId) ?? null, [sample, noteId]);
  const mark = useCallback((k: string) => setDone((d) => (d[k] ? d : { ...d, [k]: true })), []);
  const items = (sample.memory?.items ?? []).filter((i) => i.note === noteId);

  if (sample.status !== "ready" || !note) {
    return (
      <div className="narrow stack">
        <h1>The judge sample is being produced.</h1>
        <p className="lead">It is made by a real Nebius Job, never by hand. Until it lands, the measured numbers are below and on /proof.</p>
        {bench ? <BenchBlock bench={bench} /> : null}
      </div>
    );
  }
  const fleurs = sample.kind === "fleurs";
  return (
    <div className="stack">
      <div>
        <h1>Hear one voice kept in {kb(note.kept.bytesHct)}.</h1>
        <p className="lead">
          {fleurs ? (
            <>
              {FLEURS_LABEL}: {note.title}. {FLEURS_ATTRIBUTION}. The consented, actor-voiced family sample replaces it once recorded.
            </>
          ) : (
            <>Actors, consented. {note.title}</>
          )}
        </p>
      </div>
      <ol className="steps" aria-label="Three steps">
        <li className={done.original ? "done" : ""}>▶ Original</li>
        <li className={done.kept ? "done" : ""}>▶ Kept — {KEPT_LABEL.split("—")[1]?.trim()}</li>
        <li className={done.stamp ? "done" : ""}>{items.length ? "Click the stamp" : "Search “knee” — or any word you hear"}</li>
      </ol>
      {sample.notes.length > 1 ? (
        <div className="labels" role="tablist" aria-label="Sample notes">
          {sample.notes.map((n) => (
            <button key={n.id} aria-pressed={n.id === noteId} onClick={() => setNoteId(n.id)}>
              {n.label} · {mmss(n.kept.audioS)}
            </button>
          ))}
        </div>
      ) : null}
      <NoteView
        title={note.label}
        subtitle={`${note.anchor} · ${mmss(note.kept.audioS)} · ${note.transcript.lang} · real Nebius job ${note.job.nebiusId}`}
        hctUrl={note.hct}
        originalUrl={note.audio.original}
        keptUrl={note.audio.kept}
        originalLabel={`Original · ${kb(note.kept.inputBytes)}`}
        keptLabel={`Kept · ${kb(note.kept.bytesHct)}`}
        transcript={note.transcript}
        glosses={note.glosses}
        items={items}
        seek={seek}
        stepDone={(k) => mark(k)}
        keptNote={`${KEPT_LABEL}. Decoded on the Nebius Job from the ${kb(note.kept.bytesHct)} of tokens drawn above.`}
        facts={[
          { label: "Stored", value: `${kb(note.kept.bytesHct)} for ${mmss(note.kept.audioS)} of voice` },
          { label: "ASR agreement after the round trip", value: `${pct(1 - note.kept.driftNote)}` },
          { label: "Nebius job", value: `${note.job.nebiusId} · cpu-d3 · ${note.job.preset} · ${note.job.region}` },
          { label: "sha256 of the tokens", value: `${note.kept.sha256.slice(0, 16)}…` },
        ]}
        gateLine={sample.memory ? `Proposed ${sample.memory.stats.proposed} · kept ${sample.memory.stats.kept} · dropped by the quote gate ${sample.memory.stats.droppedByQuoteGate}. ${GATE_LIMIT}` : fleurs ? `FLEURS sentences are read news and encyclopaedia text, so they carry no promises; the coupons appear with the family sample. ${GATE_LIMIT}` : GATE_LIMIT}
      />
      <section className="stack" aria-label="Find in the sample">
        <h3>Find a moment</h3>
        <Find scope="sample" placeholder={fleurs ? "a word you heard, in Hindi or English" : "knee"} onOpen={(id, t0, t1) => { setNoteId(id); setSeek({ t0, t1, nonce: Date.now() }); mark("stamp"); }} />
      </section>
      {bench ? <BenchBlock bench={bench} /> : null}
      <div className="card stack">
        <strong>Keep your own note</strong>
        <p style={{ fontSize: 15 }}>
          Upload up to 60 seconds in any language the speech model is transcription-ready for (Japanese and Korean excepted); reminders are Hindi-only in v1.
          It runs a real Nebius Job{bench?.coldStart ? `; expect about ${Math.round(bench.coldStart / 60)} minutes including the VM's cold start (measured)` : ""}.
        </p>
        <Link className="btn primary" href="/?judge=1">Open an empty space</Link>
      </div>
    </div>
  );
}

export interface BenchSummary {
  bytesPerHour: number;
  werOrig: number;
  werRt: number;
  clips: number;
  asrRtf: number;
  codecRtf: number;
  usdPerAudioHour: number;
  coldStart: number | null;
  run: string;
  jobId: string;
}

export function BenchBlock({ bench }: { bench: BenchSummary }) {
  return (
    <div className="proofrow" aria-label="Measured">
      <span>{kb(bench.bytesPerHour)} per hour of voice</span>
      <span className="sep">|</span>
      <span>WER {pct(bench.werOrig)} → {pct(bench.werRt)} after the round trip (FLEURS hi_in, {bench.clips} clips)</span>
      <span className="sep">|</span>
      <span>RTF ASR {bench.asrRtf.toFixed(2)} · codec {bench.codecRtf.toFixed(2)}</span>
      <span className="sep">|</span>
      <span>${bench.usdPerAudioHour.toFixed(3)} per audio-hour</span>
      <span className="sep">|</span>
      <span>job {bench.jobId} · cpu-d3 4vcpu-16gb</span>
      <Link href="/proof">proof →</Link>
    </div>
  );
}
