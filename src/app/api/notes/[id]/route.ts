import { isId, keys } from "@/lib/keys";
import type { TranscriptDoc } from "@/lib/memory";
import type { NoteMeta } from "@/lib/pipeline";
import { json, loadSpace, notConfigured, ready } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One note: meta, transcript, and short-lived presigned GETs for its tokens, its playback copy and its original. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const { id } = await params;
  if (!isId(id)) return json({ error: "bad id" }, 400);
  const space = await loadSpace(r.store);
  if (!space) return json({ error: "no space" }, 404);
  const meta = (await r.store.getJson<NoteMeta>(keys.meta(space.uid, id)))?.value;
  if (!meta) return json({ error: "not found" }, 404);
  const transcript = (await r.store.getJson<TranscriptDoc>(keys.transcript(space.uid, id)))?.value ?? null;
  const ttl = 3600;
  const has = async (key: string) => (await r.store.head(key)).status === 200;
  const rawKey = keys.raw(space.uid, id, meta.ext);
  const origKey = keys.original(space.uid, id, meta.ext);
  const originalKey = (await has(rawKey)) ? rawKey : (await has(origKey)) ? origKey : null;
  return json({
    meta,
    transcript,
    urls: {
      hct: meta.status === "kept" ? r.store.presignGet(keys.hct(space.uid, id), ttl) : null,
      kept: (await has(keys.cacheWav(space.uid, id))) ? r.store.presignGet(keys.cacheWav(space.uid, id), ttl) : null,
      original: originalKey ? r.store.presignGet(originalKey, ttl) : null,
    },
  });
}
