import { isId, keys } from "@/lib/keys";
import { deleteOriginal, type NoteMeta } from "@/lib/pipeline";
import { json, loadSpace, notConfigured, ready } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Delete original now": DELETE raw and originals, then HEAD both; only two 404s count as deleted. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const { id } = await params;
  if (!isId(id)) return json({ error: "bad id" }, 400);
  const space = await loadSpace(r.store);
  if (!space) return json({ error: "no space" }, 404);
  const meta = (await r.store.getJson<NoteMeta>(keys.meta(space.uid, id)))?.value;
  if (!meta) return json({ error: "not found" }, 404);
  if (meta.status !== "kept") return json({ error: "Only a kept note's original can be deleted (its tokens must exist first)." }, 409);
  const after = await deleteOriginal(r.ctx, space.uid, meta);
  return json({ raw: after.raw });
}
