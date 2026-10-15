/**
 * Reads and chores over one space: list its notes and jobs, the per-space daily cap, and the memory pump that
 * remembers kept notes a few at a time (a Token Factory call takes seconds; a request must not run for minutes).
 */

import { phaseOf, utcDay } from "./caps";
import { keys, spaceTag } from "./keys";
import { rememberNote, type MemoryDoc } from "./memory";
import type { TokenFactoryConfig } from "./nebius/config";
import type { JobRecord, NoteMeta } from "./pipeline";
import type { SpaceDoc } from "./space";
import type { Store } from "./store";

export async function listNotes(store: Store, uid: string): Promise<NoteMeta[]> {
  const out: NoteMeta[] = [];
  for (const obj of await store.list(keys.notesPrefix(uid))) {
    if (!obj.key.endsWith(".meta.json")) continue;
    const m = (await store.getJson<NoteMeta>(obj.key))?.value;
    if (m) out.push(m);
  }
  return out.sort((a, b) => (a.anchor === b.anchor ? a.uploaded.localeCompare(b.uploaded) : a.anchor.localeCompare(b.anchor)));
}

export async function listJobs(store: Store, uid: string): Promise<JobRecord[]> {
  const out: JobRecord[] = [];
  for (const obj of await store.list(keys.jobsPrefix(uid))) {
    if (!/\/jobs\/[^/]+\.json$/.test(obj.key) || /\.(manifest|result|status)\.json$/.test(obj.key)) continue;
    const r = (await store.getJson<JobRecord>(obj.key))?.value;
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

export async function readMemory(store: Store, uid: string): Promise<MemoryDoc | null> {
  return (await store.getJson<MemoryDoc>(keys.memory(uid)))?.value ?? null;
}

/** Per-space daily keep count (lives in the space, so delete-all clears it; the uid-free global cap remains). */
export async function takeSpaceKeep(store: Store, uid: string, kept: boolean, bypass: boolean, now = new Date()): Promise<boolean> {
  const day = utcDay(now);
  const limit = phaseOf(day).jobsPerSpace;
  const cur = (await store.getJson<Record<string, number>>(keys.spaceCaps(uid)))?.value ?? {};
  const used = cur[day] ?? 0;
  if (!bypass && used >= limit) return false;
  await store.putJson(keys.spaceCaps(uid), { [day]: used + 1 }, { tagging: spaceTag(kept) });
  return true;
}

/** Give back one of today's per-space keeps (the keep was refused before any Job ran). */
export async function giveBackSpaceKeep(store: Store, uid: string, kept: boolean, now = new Date()): Promise<void> {
  const day = utcDay(now);
  const cur = (await store.getJson<Record<string, number>>(keys.spaceCaps(uid)))?.value ?? {};
  const used = cur[day] ?? 0;
  if (used <= 0) return;
  await store.putJson(keys.spaceCaps(uid), { [day]: used - 1 }, { tagging: spaceTag(kept) });
}

/** Remember pending notes until the time budget runs out. Returns how many were processed. */
export async function pumpMemory(
  store: Store,
  tf: TokenFactoryConfig | null,
  uid: string,
  opts: { budgetMs?: number; isSample?: boolean } = {},
): Promise<number> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 35_000;
  let n = 0;
  for (const meta of await listNotes(store, uid)) {
    if (Date.now() - started > budget) break;
    if (meta.status !== "kept" || meta.memory !== "pending") continue;
    await rememberNote(store, tf, uid, meta.id, { isSample: opts.isSample });
    n += 1;
  }
  return n;
}

/** Re-run memory for notes paused before the space opted in. */
export async function resumePaused(store: Store, uid: string, space: SpaceDoc): Promise<number> {
  let n = 0;
  for (const meta of await listNotes(store, uid)) {
    if (meta.memory !== "paused") continue;
    meta.memory = "pending";
    await store.putJson(keys.meta(uid, meta.id), meta, { tagging: spaceTag(space.kept) });
    n += 1;
  }
  return n;
}
