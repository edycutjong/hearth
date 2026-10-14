import { CONSENT_VERSION } from "@/lib/copy";
import { json, loadSpace, notConfigured, ready, saveSpace } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-space opt-in to send transcript TEXT to Token Factory under its default retention, shown only while
 * Zero Data Retention is not on for the organisation. Body: { optIn: boolean }.
 */
export async function POST(req: Request) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const body = (await req.json().catch(() => ({}))) as { optIn?: boolean };
  const space = await loadSpace(r.store);
  if (!space) return json({ error: "no space" }, 404);
  space.doc.tfOptIn = body.optIn ? { at: new Date().toISOString(), textVersion: CONSENT_VERSION } : null;
  await saveSpace(r.store, space.uid, space.doc);
  return json({ tfOptIn: Boolean(space.doc.tfOptIn) });
}
