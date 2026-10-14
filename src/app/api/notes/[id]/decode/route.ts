import { takeDaily } from "@/lib/caps";
import { isId, keys, spaceTag } from "@/lib/keys";
import { dispatch, enqueue, queuePosition, type NoteMeta } from "@/lib/pipeline";
import { json, loadSpace, notConfigured, ready } from "@/lib/server";
import { listNotes } from "@/lib/space-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The playback copy expired (it lives 24 h): queue a decode-only Job that rebuilds it from the tokens for the
 * space's notes of the last 7 days (<= 20 min of audio) in one run. One per space per minute; a global daily cap.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const { id } = await params;
  if (!isId(id)) return json({ error: "bad id" }, 400);
  const space = await loadSpace(r.store);
  if (!space) return json({ error: "no space" }, 404);
  const meta = (await r.store.getJson<NoteMeta>(keys.meta(space.uid, id)))?.value;
  if (!meta || meta.status !== "kept") return json({ error: "not a kept note" }, 404);
  const last = (await r.store.getJson<{ at: string }>(`u/${space.uid}/decode-last.json`))?.value;
  if (last && Date.now() - new Date(last.at).getTime() < 60_000) return json({ error: "A decode was just requested; wait a minute." }, 429);
  if (!(await takeDaily(r.store, "decodeJobs"))) return json({ error: "Today's decode budget is used (resets 00:00 UTC)." }, 429);
  await r.store.putJson(`u/${space.uid}/decode-last.json`, { at: new Date().toISOString() }, { tagging: spaceTag(space.doc.kept) });
  const weekAgo = Date.now() - 7 * 86_400_000;
  const missing = [];
  let seconds = 0;
  for (const n of [meta, ...(await listNotes(r.store, space.uid)).filter((n) => n.id !== meta.id)]) {
    if (n.status !== "kept" || new Date(n.uploaded).getTime() < weekAgo) continue;
    if ((await r.store.head(keys.cacheWav(space.uid, n.id))).status === 200) continue;
    if (seconds + (n.kept?.audioS ?? 0) > 1200) break;
    seconds += n.kept?.audioS ?? 0;
    missing.push({ id: n.id, ext: n.ext });
  }
  if (!missing.length) return json({ ok: true, note: "the playback copy already exists" });
  const { job, queueKey } = await enqueue(r.ctx, space.uid, "decode", missing);
  const outcome = await dispatch(r.ctx).catch(() => "none");
  return json({ job, dispatch: outcome, queuePosition: await queuePosition(r.ctx, queueKey), notes: missing.length });
}
