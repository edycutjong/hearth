import { takeDaily } from "@/lib/caps";
import { MAX_UPLOAD_BYTES, isId, keys, spaceTag } from "@/lib/keys";
import { dispatch, enqueue, queuePosition, type NoteMeta } from "@/lib/pipeline";
import { isJudgeCode, json, loadSpace, notConfigured, ready } from "@/lib/server";
import { giveBackSpaceKeep, takeSpaceKeep } from "@/lib/space-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Keep uploaded notes: check each upload landed, apply the caps, queue ONE Nebius Job for the batch. */
export async function POST(req: Request) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const space = await loadSpace(r.store);
  if (!space) return json({ error: "no space" }, 404);
  if (!space.doc.consent) return json({ error: "Tick the consent first." }, 403);
  const body = (await req.json().catch(() => ({}))) as { notes?: string[]; code?: string };
  const ids = (body.notes ?? []).filter(isId).slice(0, 20);
  if (!ids.length) return json({ error: "No notes to keep." }, 400);
  const tag = spaceTag(space.doc.kept);
  const found: Array<{ meta: NoteMeta; etag: string | null; ref: { id: string; ext: string } }> = [];
  for (const id of ids) {
    const got = await r.store.getJson<NoteMeta>(keys.meta(space.uid, id));
    const meta = got?.value;
    if (!meta || !["uploading", "uploaded"].includes(meta.status)) continue;
    const head = await r.store.head(keys.raw(space.uid, id, meta.ext));
    if (head.status !== 200 || !head.size) return json({ error: `The upload of "${meta.name}" did not arrive.` }, 409);
    if (head.size > MAX_UPLOAD_BYTES) {
      // The presigned PUT cannot bound the size; the stored object can be checked.
      await r.store.delete(keys.raw(space.uid, id, meta.ext));
      return json({ error: `"${meta.name}" is larger than 25 MB, so it was removed.` }, 413);
    }
    found.push({ meta, etag: got?.etag ?? null, ref: { id, ext: meta.ext } });
  }
  if (!found.length) return json({ error: "These notes are already kept or queued." }, 409);
  // Claim the notes before spending any allowance: a double submit queues them once (If-Match on each note).
  const notes: typeof found = [];
  for (const n of found) {
    n.meta.status = "queued";
    delete n.meta.error;
    const w = await r.store.putJson(keys.meta(space.uid, n.meta.id), n.meta, { tagging: tag, condition: n.etag ? { ifMatch: n.etag } : undefined });
    if (w.ok) notes.push(n);
  }
  if (!notes.length) return json({ error: "These notes are already queued." }, 409);
  const unclaim = async () => {
    for (const n of notes) {
      n.meta.status = "uploaded";
      await r.store.putJson(keys.meta(space.uid, n.meta.id), n.meta, { tagging: tag });
    }
  };
  const bypass = isJudgeCode(body.code);
  if (!(await takeSpaceKeep(r.store, space.uid, space.doc.kept, bypass))) {
    await unclaim();
    return json({ error: "This space has used today's free processing (resets 00:00 UTC). The sample and /proof still work.", capped: true }, 429);
  }
  if (!(await takeDaily(r.store, "jobs", new Date(), bypass))) {
    await giveBackSpaceKeep(r.store, space.uid, space.doc.kept);
    await unclaim();
    return json({ error: "Today's free processing is used up (resets 00:00 UTC). The sample and /proof still work.", capped: true }, 429);
  }
  const { job, queueKey } = await enqueue(r.ctx, space.uid, "keep", notes.map((n) => n.ref), {
    maxNoteSeconds: space.doc.judge ? 60 : 300,
    lang: space.doc.judge ? "detect" : "hi-IN",
  });
  const outcome = await dispatch(r.ctx).catch((e: unknown) => `error: ${String(e).slice(0, 120)}`);
  return json({ job, dispatch: outcome, queuePosition: await queuePosition(r.ctx, queueKey) });
}
