"use client";

import { useState } from "react";
import { TF_OPTIN } from "@/lib/copy";
import { googleSubscribeLink, googleTemplateLink } from "@/lib/ics";
import type { MemoryDoc } from "@/lib/memory";
import type { NoteMeta } from "@/lib/pipeline";
import { Coupon } from "../Coupon";
import { api, type SpaceInfo } from "./types";

/** Everything kept as a reminder, soonest first, with the calendar feed that delivers them while Hearth is closed. */
export function Kept({ space, memory, notes, zdrConfirmed, zdrOn, onOpen, onChanged }: {
  space: SpaceInfo;
  memory: MemoryDoc | null;
  notes: NoteMeta[];
  zdrConfirmed: boolean;
  zdrOn: boolean;
  onOpen: (id: string, t0: number, t1: number) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ hi: string; en: string } | null>(null);
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const items = [...(memory?.items ?? [])].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const paused = notes.filter((n) => n.memory === "paused").length;
  const base = typeof window === "undefined" ? "" : window.location.origin;
  const feed = space.feedUrl ?? "";
  const open = items.filter((i) => i.state === "open" && i.due);
  return (
    <div className="stack">
      <h1>Kept promises</h1>
      {!zdrOn && !space.tfOptIn ? (
        <div className="coupon paused stack">
          <strong>{TF_OPTIN.title}</strong>
          <p style={{ fontSize: 15 }}>{TF_OPTIN.body(zdrConfirmed)}</p>
          <p className="note-hint">
            {paused ? `${paused} kept note${paused === 1 ? " is" : "s are"} waiting. ` : ""}Until you turn this on, nothing is sent and reminders stay paused.
          </p>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api("/api/optin", { method: "POST", body: JSON.stringify({ optIn: true }) });
              setBusy(false);
              onChanged();
            }}
          >
            Turn on reminders
          </button>
        </div>
      ) : null}
      <div className="card stack">
        <strong>Always on: your phone&apos;s calendar</strong>
        <p style={{ fontSize: 15 }}>
          Subscribe once. Your calendar fetches the reminders on its own schedule and each one carries its own alarm, so it
          fires with Hearth closed. The feed holds neutral titles and dates only.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="btn small" href={feed.replace(/^https?:/, "webcal:")}>Subscribe (iPhone, Mac, desktop)</a>
          <a className="btn small" href={googleSubscribeLink(feed)} target="_blank" rel="noreferrer">Subscribe in Google Calendar (Android)</a>
          <a className="btn small" href={feed}>Download .ics</a>
        </div>
        <p className="note-hint">How fast a subscribed calendar picks up a new reminder depends on the provider and has not been measured yet.</p>
      </div>
      {items.length ? (
        items.map((it) => (
          <Coupon key={it.id} item={it} gloss={memory?.glosses[it.note]?.[String(it.segments[0])]} onPlay={(t0, t1) => onOpen(it.note, t0, t1)} calendarHref={googleTemplateLink(it, base)} />
        ))
      ) : (
        <p className="muted">Nothing kept yet. When a note asks for something, it appears here quoted word for word.</p>
      )}
      {memory ? (
        <p className="gate">
          Proposed {memory.stats.proposed} · kept {memory.stats.kept} · dropped by the quote gate {memory.stats.droppedByQuoteGate} (quote not in the transcript) · amounts removed {memory.stats.amountRemoved} · dates removed {memory.stats.whenRemoved} · marked received {memory.stats.resolved}
        </p>
      ) : null}
      {open.length ? (
        <div className="card stack">
          <strong>Draft a reply</strong>
          <p className="note-hint">Nemotron 3 Super drafts it from the open items. Hearth never sends it — copy it into your chat yourself.</p>
          <button
            className="btn small"
            onClick={async () => {
              setDraftErr(null);
              const r = await api<{ draft?: { hi: string; en: string }; error?: string }>("/api/draft", { method: "POST", body: JSON.stringify({ items: open.map((i) => i.id), recipient: open[0]?.who ?? "Maa" }) });
              if (r.data.draft) setDraft(r.data.draft);
              else setDraftErr(r.data.error ?? "No draft.");
            }}
          >
            Draft
          </button>
          {draft ? (
            <div>
              <p lang="hi" style={{ fontSize: 19, fontWeight: 600 }}>{draft.hi}</p>
              <p className="note-hint">Machine translation: {draft.en}</p>
              <button className="btn small" onClick={() => void navigator.clipboard.writeText(draft.hi)}>Copy</button>
            </div>
          ) : null}
          {draftErr ? <p className="error">{draftErr}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
