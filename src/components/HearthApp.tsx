"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Agree } from "./app/Agree";
import { Find } from "./app/Find";
import { Forward } from "./app/Forward";
import { Keeping } from "./app/Keeping";
import { Kept } from "./app/Kept";
import { NoteDetail } from "./app/NoteDetail";
import { NotesList } from "./app/NotesList";
import { You } from "./app/You";
import { api, type SpaceInfo } from "./app/types";
import { useStatus } from "./app/useStatus";

type Tab = "notes" | "kept" | "find" | "you";
const TABS: Array<[Tab, string]> = [
  ["notes", "Notes"],
  ["kept", "Kept"],
  ["find", "Find"],
  ["you", "You"],
];
/** A judge space keeps notes of up to 60 s, in any transcription-ready language (the worker detects it). */
const JUDGE_MAX_S = 60;

type Listing = Array<{ prefix: string; count: number }>;

/** The product: one flow — forward, keep, remember, hear and find, control. */
export function HearthApp() {
  const [space, setSpace] = useState<SpaceInfo | null>(null);
  const [boot, setBoot] = useState<"loading" | "ready" | "unconfigured" | "error">("loading");
  const [tab, setTab] = useState<Tab>("notes");
  const [open, setOpen] = useState<string | null>(null);
  const [seek, setSeek] = useState<{ t0: number; t1: number; nonce: number } | null>(null);
  const [code, setCode] = useState<string | undefined>(undefined);
  const [deleted, setDeleted] = useState<Listing | null>(null);
  const [stillRunning, setStillRunning] = useState<string[]>([]);
  const { status, error, gone, refresh } = useStatus(boot === "ready" && !deleted);

  const openSpace = useCallback(async (judge: boolean) => {
    const r = await api<SpaceInfo & { error?: string }>("/api/space", {
      method: "POST",
      body: JSON.stringify({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, judge }),
    });
    if (r.status === 503) setBoot("unconfigured");
    else if (!r.ok) setBoot("error");
    else {
      setSpace(r.data);
      setBoot("ready");
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const note = params.get("note");
    if (note) setOpen(note);
    const c = params.get("code");
    if (c) {
      sessionStorage.setItem("hearth-code", c);
      setCode(c);
    } else {
      setCode(sessionStorage.getItem("hearth-code") ?? undefined);
    }
    void openSpace(params.get("judge") === "1");
  }, [openSpace]);

  const openAt = useCallback((id: string, t0?: number, t1?: number) => {
    setOpen(id);
    setTab("notes");
    if (t0 !== undefined && t1 !== undefined) setSeek({ t0, t1, nonce: Date.now() });
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
  }, []);

  const pick = (k: Tab) => {
    setTab(k);
    setOpen(null);
    setSeek(null);
  };

  if (boot === "loading") return <p className="muted">Opening your space…</p>;
  if (boot === "unconfigured")
    return (
      <div className="narrow stack">
        <h1>This copy of Hearth has no Nebius credentials.</h1>
        <p className="lead">It can still show the judge sample — a real Nebius Job&apos;s output — with its A/B, search and proof.</p>
        <Link className="btn primary" href="/judge">Open the judge sample</Link>
      </div>
    );
  if (boot === "error") return <p className="error">Hearth could not open a space. Reload to try again.</p>;

  if (deleted || gone)
    return (
      <div className="narrow stack">
        <h1>Everything is deleted.</h1>
        {deleted ? (
          <>
            <p className="lead">After deleting, Hearth listed your three storage prefixes again:</p>
            <div className="listing" aria-live="polite">
              {deleted.map((l) => (
                <div key={l.prefix}>
                  {l.prefix} → {l.count} object{l.count === 1 ? "" : "s"}
                </div>
              ))}
            </div>
            <p className="note-hint">
              Your calendar feed now answers 410. What remains: the anonymous daily counters, which carry no id, and a deletion marker
              that the daily sweep removes after deleting these prefixes once more.
              {stillRunning.length
                ? ` A Nebius Job (${stillRunning.join(", ")}) was still stopping; anything it writes before it stops is deleted by that sweep.`
                : ""}
            </p>
          </>
        ) : (
          <p className="lead">This space no longer exists: it was deleted, or it expired after 7 days.</p>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn primary"
            onClick={() => {
              setDeleted(null);
              setOpen(null);
              setTab("notes");
              setBoot("loading");
              void openSpace(false).then(() => refresh());
            }}
          >
            Start a new space
          </button>
          <Link className="btn" href="/judge">Open the judge sample</Link>
        </div>
      </div>
    );

  const s = status?.space ?? space;
  if (!s) return <p className="muted">Opening your space…</p>;
  if (!s.consent) return <Agree zdrConfirmed={status?.flags.zdrConfirmed ?? false} judge={Boolean(s.judge)} onDone={() => void refresh().then(() => setSpace({ ...s, consent: { at: "", textVersion: "", deleteOriginals: true } }))} />;

  const notes = status?.notes ?? [];
  const jobs = status?.jobs ?? [];
  const active = jobs.filter((j) => ["queued", "dispatched", "running", "finalizing"].includes(j.state));
  const judge = Boolean(s.judge);

  return (
    <div>
      <nav className="topnav sections" aria-label="Sections">
        {TABS.map(([k, label]) => (
          <button key={k} aria-current={tab === k ? "page" : undefined} onClick={() => pick(k)}>
            {label}
          </button>
        ))}
      </nav>
      {error ? <p className="error" style={{ marginBottom: 12 }}>{error}</p> : null}
      {tab === "notes" ? (
        open ? (
          <NoteDetail id={open} memory={status?.memory ?? null} seek={seek} onSeekUsed={() => setSeek(null)} onBack={() => {
            setOpen(null);
            setSeek(null);
          }} onChanged={() => void refresh()} />
        ) : (
          <div className="stack">
            <h1>Your notes</h1>
            {judge ? (
              <p className="lead">
                A judge space: notes up to 60 seconds, in any language the speech model is transcription-ready for (not Japanese or Korean).
                Reminders are Hindi-only.
              </p>
            ) : null}
            <Forward onKept={() => void refresh()} maxSeconds={judge ? JUDGE_MAX_S : undefined} code={code} />
            {active.map((j) => (
              <Keeping key={j.job} job={j} notes={notes.filter((n) => j.notes.some((x) => x.id === n.id))} queuePos={status?.queue[j.job] ?? null} eta={status?.eta ?? null} />
            ))}
            <h3>Kept so far</h3>
            <NotesList notes={notes.filter((n) => n.status !== "uploading")} onOpen={(id) => openAt(id)} />
            {status ? (
              <p className="note-hint">
                Free processing today: {status.caps.jobs} of {status.caps.limit} runs used (all visitors). The judge sample and /proof are never capped.
              </p>
            ) : null}
          </div>
        )
      ) : null}
      {tab === "kept" && status ? (
        <Kept space={s} memory={status.memory} notes={notes} zdrConfirmed={status.flags.zdrConfirmed} zdrOn={status.flags.zdrOn} onOpen={openAt} onChanged={() => void refresh()} />
      ) : null}
      {tab === "find" ? (
        <div className="stack">
          <h1>Find</h1>
          <p className="lead">Ask in English or Hindi — “knee”, “पैसे”, “5000”. You land on the moment it was said.</p>
          <Find onOpen={openAt} />
        </div>
      ) : null}
      {tab === "you" ? <You space={s} zdrConfirmed={status?.flags.zdrConfirmed ?? false} onChanged={() => void refresh()} onDeleted={(l, running) => {
            setDeleted(l);
            setStillRunning(running);
          }} /> : null}
      <nav className="tabs" aria-label="Sections">
        {TABS.map(([k, label]) => (
          <button key={k} aria-current={tab === k ? "page" : undefined} onClick={() => pick(k)}>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
