import { createHash } from "node:crypto";
import { takeDaily } from "@/lib/caps";
import { normalizeHi } from "@/lib/hindi/normalize";
import { keys } from "@/lib/keys";
import type { TranscriptDoc } from "@/lib/memory";
import { memoryAllowsTf, sampleDocs } from "@/lib/sample";
import { queryTerms, rank, type SearchDoc } from "@/lib/search";
import { json, loadSpace, ready, tfConfig } from "@/lib/server";
import { listNotes, readMemory } from "@/lib/space-ops";
import { expandQuery } from "@/lib/tf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Search. The query travels in the body, never the URL, so family search terms stay out of request logs.
 * Super expands it (when Token Factory may see this space's text); code ranks REAL segments with BM25.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { q?: string; scope?: "space" | "sample" };
  const q = String(body.q ?? "").trim().slice(0, 120);
  if (!q) return json({ hits: [], terms: [] });
  let docs: SearchDoc[] = [];
  let allowTf = true;
  if (body.scope === "sample") {
    docs = await sampleDocs();
  } else {
    const r = ready();
    if (!r.ok) return json({ hits: [], terms: [], note: "no space on this deployment" });
    const space = await loadSpace(r.store);
    if (!space) return json({ hits: [], terms: [] });
    allowTf = memoryAllowsTf(space.doc);
    const memory = await readMemory(r.store, space.uid);
    for (const meta of await listNotes(r.store, space.uid)) {
      if (meta.status !== "kept") continue;
      const t = (await r.store.getJson<TranscriptDoc>(keys.transcript(space.uid, meta.id)))?.value;
      for (const s of t?.segments ?? []) {
        docs.push({
          note: meta.id, segment: s.i, t0: s.t0, t1: s.t1, text: s.text, label: meta.label, anchor: meta.anchor,
          gloss: memory?.glosses[meta.id]?.[String(s.i)],
          amounts: (memory?.items ?? []).filter((i) => i.note === meta.id && i.segments.includes(s.i) && i.amount !== null).map((i) => i.amount as number),
        });
      }
    }
  }
  const tf = tfConfig();
  const r = ready();
  let expansion: string[] = [];
  let expanded: { requestId: string | null; error: string | null; cached?: boolean } | null = null;
  if (tf && allowTf && r.ok) {
    // The sample is public: its expansions are cached, and every Token Factory call counts against a daily cap
    // (uid-free), past which search runs as typed. A loop on this route cannot burn the shared credit.
    const cacheKey = body.scope === "sample" ? `sys/cache/exp-${createHash("sha256").update(normalizeHi(q.toLowerCase())).digest("hex").slice(0, 24)}.json` : null;
    const cached = cacheKey ? (await r.store.getJson<{ terms: string[]; requestId: string | null }>(cacheKey))?.value : null;
    if (cached) {
      expansion = cached.terms;
      expanded = { requestId: cached.requestId, error: null, cached: true };
    } else if (await takeDaily(r.store, body.scope === "sample" ? "tfSample" : "tfCalls")) {
      const call = await expandQuery(tf, q);
      expanded = { requestId: call.requestId, error: call.error };
      if (call.value) {
        expansion = [...call.value.terms_hi, ...call.value.terms_en];
        if (cacheKey) await r.store.putJson(cacheKey, { terms: expansion, requestId: call.requestId }).catch(() => undefined);
      }
    }
  }
  const terms = queryTerms(q, expansion);
  return json({ hits: rank(docs, terms, 5), terms: expansion, lexicalOnly: !expansion.length, expanded });
}
