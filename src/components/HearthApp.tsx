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

/** The product: one flow — forward, keep, remember, hear and find, control. */
export function HearthApp() {
  const [space, setSpace] = useState<SpaceInfo | null>(null);
  const [boot, setBoot] = useState<"loading" | "ready" | "unconfigured" | "error">("loading");
  const [tab, setTab] = useState<Tab>("notes");
  const [open, setOpen] = useState<string | null>(null);
  const [seek, setSeek] = useState<{ t0: number; t1: number; nonce: number } | null>(null);
  const { status, error, refresh } = useStatus(boot === "ready");

  useEffect(() => {
    void (async () => {
      const r = await api<SpaceInfo & { error?: string }>("/api/space", {
        method: "POST",
        body: JSON.stringify({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      if (r.status === 503) setBoot("unconfigured");
      else if (!r.ok) setBoot("error");
      else {
        setSpace(r.data);
        setBoot("ready");
      }
    })();
  }, []);

  useEffect(() => {
    const note = new URLSearchParams(window.location.search).get("note");
    if (note) setOpen(note);
  }, []);

  const openAt = useCallback((id: string, t0?: number, t1?: number) => {
    setOpen(id);
    setTab("notes");
    if (t0 !== undefined && t1 !== undefined) setSeek({ t0, t1, nonce: Date.now() });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

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

  const s = status?.space ?? space;
  if (!s) return <p className="muted">Opening your space…</p>;
  if (!s.consent) return <Agree zdrConfirmed={status?.flags.zdrConfirmed ?? false} onDone={() => void refresh().then(() => setSpace({ ...s, consent: { at: "", textVersion: "", deleteOriginals: true } }))} />;

  const notes = status?.notes ?? [];
  const jobs = status?.jobs ?? [];
  const active = jobs.filter((j) => ["queued", "dispatched", "running", "finalizing"].includes(j.state));

  return (
    <div>
      <nav className="topnav" aria-label="Sections" style={{ marginBottom: 18, display: "flex" }}>
        {TABS.map(([k, label]) => (
          <button key={k} aria-current={tab === k ? "page" : undefined} onClick={() => { setTab(k); if (k !== "notes") setOpen(null); }}>
            {label}
          </button>
        ))}
      </nav>
      {error ? <p className="error" style={{ marginBottom: 12 }}>{error}</p> : null}
      {tab === "notes" ? (
        open ? (
          <NoteDetail id={open} memory={status?.memory ?? null} seek={seek} onBack={() => setOpen(null)} onChanged={() => void refresh()} />
        ) : (
          <div className="stack">
            <h1>Your notes</h1>
            <Forward onKept={() => void refresh()} />
            {active.map((j) => (
              <Keeping key={j.job} job={j} notes={notes.filter((n) => j.notes.some((x) => x.id === n.id))} queuePos={status?.queue[j.job] ?? null} />
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
          <h2>Find</h2>
          <p className="lead">Ask in English or Hindi — “knee”, “पैसे”, “5000”. You land on the moment it was said.</p>
          <Find onOpen={openAt} />
        </div>
      ) : null}
      {tab === "you" ? <You space={s} zdrConfirmed={status?.flags.zdrConfirmed ?? false} onChanged={() => void refresh()} /> : null}
      <nav className="tabs" aria-label="Sections">
        {TABS.map(([k, label]) => (
          <button key={k} aria-current={tab === k ? "page" : undefined} onClick={() => { setTab(k); if (k !== "notes") setOpen(null); }}>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
