/**
 * Persistent memory: one `memory.json` per space, rewritten with If-Match (412 -> re-read, re-merge, <= 3 tries).
 *
 * For each kept note: Nemotron 3 Super proposes items from the transcript text -> the quote gate drops what is
 * not verbatim in the transcript -> the field gate removes amounts and dates the quote does not carry -> the
 * resolver dates what is left from the note's own timestamp. Drops are COUNTED and shown, never hidden.
 * A later note can mark an earlier money ask received («पैसे मिल गए»), but only when Super links them, the quote
 * itself says the money arrived (receiptStated), AND the amounts agree (or the later quote states none). A link that
 * fails this is dropped and counted — it never becomes a new reminder.
 *
 * Exactly one request remembers a note: it claims the note (If-Match on its meta) before calling Token Factory, and
 * applying an extraction is idempotent per note. A transient Token Factory error is retried twice with backoff.
 *
 * Privacy gate: transcript text reaches Token Factory only for the sample, when Zero Data Retention is on for
 * the organisation (TF_ZDR_ON), or when this space opted in after reading the default-retention sentence.
 * Otherwise the note's reminders are "paused" and nothing is sent.
 */

import { createHash } from "node:crypto";
import { localDate, resolveDue, type DueStatus } from "./dates";
import { fieldGate, quoteGate, receiptStated, type AmountStatus, type ItemKind, type Segment, type WhenStatus } from "./gates";
import type { VerifiedWhen } from "./dates";
import { keys, spaceTag } from "./keys";
import type { TokenFactoryConfig } from "./nebius/config";
import type { NoteMeta } from "./pipeline";
import type { SpaceDoc } from "./space";
import type { Store } from "./store";
import { extract, type Extraction, type TfCall } from "./tf";

export interface MemoryItem {
  id: string;
  note: string;
  kind: ItemKind;
  who: string;
  what_en: string;
  quote: string;
  segments: number[];
  t0: number;
  t1: number;
  amount: number | null;
  amountStatus: AmountStatus;
  when: VerifiedWhen | null;
  whenStatus: WhenStatus;
  whenRaw: string | null;
  due: string | null;
  dueStatus: DueStatus;
  dueLabel: string;
  state: "open" | "received";
  receivedBy?: { note: string; quote: string; at: string };
  segmentCorrected: boolean;
  created: string;
  tfRequestId: string | null;
}

export interface MemoryStats {
  proposed: number;
  droppedByQuoteGate: number;
  amountRemoved: number;
  whenRemoved: number;
  kept: number;
  resolved: number;
}

export interface MemoryDoc {
  version: 1;
  items: MemoryItem[];
  glosses: Record<string, Record<string, string>>;
  stats: MemoryStats;
  dropped: Array<{ note: string; quote: string; reason: string }>;
  calls: Array<{ note: string; requestId: string | null; model: string; ms: number; at: string; error?: string }>;
}

export function emptyMemory(): MemoryDoc {
  return {
    version: 1,
    items: [],
    glosses: {},
    stats: { proposed: 0, droppedByQuoteGate: 0, amountRemoved: 0, whenRemoved: 0, kept: 0, resolved: 0 },
    dropped: [],
    calls: [],
  };
}

export interface TranscriptDoc {
  version: 1;
  note?: string;
  lang: string;
  lang_detected: string | null;
  duration_s: number;
  runtime?: Record<string, unknown>;
  segments: Segment[];
}

export function itemId(note: string, segment: number, quote: string): string {
  return createHash("sha256").update(`${note}:${segment}:${quote}`).digest("hex").slice(0, 16);
}

/** Pure: judge one extraction against one transcript and merge it into a memory document. */
export function applyExtraction(
  memory: MemoryDoc,
  note: { id: string; anchor: string; label: string },
  transcript: TranscriptDoc,
  call: TfCall<Extraction>,
  today: string,
  now: Date,
): MemoryDoc {
  // Idempotent per note: an extraction that already landed for this note is never counted or applied twice.
  if (call.value && memory.calls.some((c) => c.note === note.id && !c.error)) return memory;
  const next = structuredClone(memory);
  next.calls.push({ note: note.id, requestId: call.requestId, model: call.model, ms: call.durationMs, at: now.toISOString(), ...(call.error ? { error: call.error } : {}) });
  if (!call.value) return next;
  const glosses: Record<string, string> = {};
  for (const g of call.value.glosses ?? []) glosses[String(g.segment)] = g.en;
  next.glosses[note.id] = glosses;
  for (const item of call.value.items ?? []) {
    next.stats.proposed += 1;
    const q = quoteGate(item.quote ?? "", item.segment ?? -1, transcript.segments);
    if (!q.ok) {
      next.stats.droppedByQuoteGate += 1;
      next.dropped.push({ note: note.id, quote: item.quote ?? "", reason: q.reason });
      continue;
    }
    // Received: a later quote resolving an earlier open money ask. Never a new reminder, whatever the outcome.
    if (item.resolves) {
      const target = next.items.find((i) => i.id === item.resolves && i.state === "open" && i.kind === "money");
      const f = fieldGate(item, item.quote);
      if (target && receiptStated(item.quote) && (f.amount === null || f.amount === target.amount)) {
        target.state = "received";
        target.receivedBy = { note: note.id, quote: item.quote, at: now.toISOString() };
        next.stats.resolved += 1;
      } else {
        next.dropped.push({ note: note.id, quote: item.quote, reason: target ? "resolve_not_verified" : "resolve_target_unknown" });
      }
      continue;
    }
    const f = fieldGate(item, item.quote);
    if (f.amountStatus === "removed") next.stats.amountRemoved += 1;
    if (f.whenStatus === "removed") next.stats.whenRemoved += 1;
    const due = resolveDue(f.when, note.anchor, today);
    const segs = transcript.segments.filter((s) => q.segments.includes(s.i));
    const id = itemId(note.id, q.segments[0] ?? 0, item.quote);
    if (next.items.some((i) => i.id === id)) continue;
    next.items.push({
      id,
      note: note.id,
      kind: item.kind,
      who: item.who || note.label,
      what_en: item.what_en,
      quote: item.quote,
      segments: q.segments,
      t0: Math.min(...segs.map((s) => s.t0)),
      t1: Math.max(...segs.map((s) => s.t1)),
      amount: item.kind === "money" ? f.amount : null,
      amountStatus: f.amountStatus,
      when: f.when,
      whenStatus: f.whenStatus,
      whenRaw: item.when?.raw ?? null,
      due: due.due,
      dueStatus: due.status,
      dueLabel: due.label,
      state: "open",
      segmentCorrected: q.ok && q.corrected,
      created: now.toISOString(),
      tfRequestId: call.requestId,
    });
    next.stats.kept += 1;
  }
  return next;
}

export function tfAllowed(space: SpaceDoc | null, isSample: boolean, env: Record<string, string | undefined> = process.env): boolean {
  if (isSample) return true;
  if (env.TF_ZDR_ON === "true") return true;
  return Boolean(space?.tfOptIn);
}

/** Errors worth a retry: rate limits, server errors, timeouts, an empty or unparsable answer. */
export function retryableTfError(error: string | null): boolean {
  return !!error && /returned (429|5\d\d)|request failed|returned no answer|not valid JSON|aborted|timeout/i.test(error);
}

export const MEMORY_CLAIM_STALE_MS = 3 * 60_000;
const MAX_TF_TRIES = 3;

/** Remember one kept note. Returns the memory state the note ends in. */
export async function rememberNote(
  store: Store,
  tf: TokenFactoryConfig | null,
  uid: string,
  noteId: string,
  opts: { isSample?: boolean; now?: Date; env?: Record<string, string | undefined>; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<NoteMeta["memory"]> {
  const now = opts.now ?? new Date();
  const space = (await store.getJson<SpaceDoc>(keys.space(uid)))?.value ?? null;
  const tag = spaceTag(space?.kept ?? false);
  const metaGot = await store.getJson<NoteMeta>(keys.meta(uid, noteId));
  if (!metaGot) return "failed";
  const meta = metaGot.value;
  // Every later write re-reads the meta, so a long Token Factory call never overwrites newer state (raw deletion...).
  const save = async (state: NoteMeta["memory"], patch: Partial<NoteMeta> = {}, error?: string) => {
    const fresh = (await store.getJson<NoteMeta>(keys.meta(uid, noteId)))?.value ?? meta;
    Object.assign(fresh, patch);
    fresh.memory = state;
    if (error) fresh.memoryError = error;
    else delete fresh.memoryError;
    if (state !== "running") delete fresh.memoryClaimedAt;
    await store.putJson(keys.meta(uid, noteId), fresh, { tagging: tag });
    return state;
  };
  if (!tfAllowed(space, opts.isSample ?? false, opts.env)) return save("paused");
  if (!tf) return save("failed", {}, "Token Factory is not configured on this deployment");
  const transcript = (await store.getJson<TranscriptDoc>(keys.transcript(uid, noteId)))?.value;
  if (!transcript) return save("failed", {}, "no transcript");
  const lang = meta.kept?.langDetected;
  if (lang && lang !== "hi-IN" && transcript.lang !== "hi-IN") return save("skipped", {}, "reminders are Hindi-only in v1");
  // Claim: exactly one request calls Token Factory for this note.
  const claimed = await store.putJson(
    keys.meta(uid, noteId),
    { ...meta, memory: "running", memoryClaimedAt: now.toISOString() },
    { tagging: tag, condition: metaGot.etag ? { ifMatch: metaGot.etag } : undefined },
  );
  if (!claimed.ok) return meta.memory;
  const current = (await store.getJson<MemoryDoc>(keys.memory(uid)))?.value ?? emptyMemory();
  if (current.calls.some((c) => c.note === noteId && !c.error)) return save("done"); // already remembered
  const openItems = current.items
    .filter((i) => i.state === "open" && i.kind === "money")
    .map((i) => ({ id: i.id, kind: i.kind, what_en: i.what_en, amount_inr: i.amount }));
  const call = await extract(
    tf,
    {
      senderLabel: meta.label || "the sender",
      noteDate: `${meta.anchor} (${new Date(`${meta.anchor}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })})`,
      segments: transcript.segments,
      openItems,
    },
    opts.fetchImpl,
    opts.timeoutMs,
  );
  const tries = (meta.memoryTries ?? 0) + 1;
  if (retryableTfError(call.error) && tries < MAX_TF_TRIES) {
    // Transient: try again later, without recording a failure.
    return save("pending", { memoryTries: tries, memoryNextTry: new Date(now.getTime() + tries * 60_000).toISOString() }, call.error ?? undefined);
  }
  const today = localDate(now, space?.timeZone ?? "UTC");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cur = await store.getJson<MemoryDoc>(keys.memory(uid));
    const merged = applyExtraction(cur?.value ?? emptyMemory(), { id: noteId, anchor: meta.anchor, label: meta.label }, transcript, call, today, now);
    const w = await store.putJson(keys.memory(uid), merged, {
      tagging: tag,
      condition: cur?.etag ? { ifMatch: cur.etag } : { ifNoneMatch: "*" },
    });
    if (w.ok) return save(call.error ? "failed" : "done", { memoryTries: tries }, call.error ?? undefined);
  }
  return save("failed", { memoryTries: tries }, "memory changed under us three times; try again");
}
