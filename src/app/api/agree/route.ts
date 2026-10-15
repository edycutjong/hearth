import { CONSENT_VERSION } from "@/lib/copy";
import { json, loadSpace, notConfigured, ready, saveSpace, readBody } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Record the consent tick (date + text version) and the one choice: delete originals after a verified round trip. */
export async function POST(req: Request) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const body = await readBody<{ agreed?: boolean; deleteOriginals?: boolean; textVersion?: string }>(req);
  if (body.agreed !== true || body.textVersion !== CONSENT_VERSION) return json({ error: "consent must be ticked on the current text" }, 400);
  const space = await loadSpace(r.store, { create: true });
  if (!space) return json({ error: "no space" }, 500);
  // A later change of the delete-originals choice keeps the date the text was agreed to.
  const kept = space.doc.consent?.textVersion === CONSENT_VERSION ? space.doc.consent.at : null;
  space.doc.consent = { at: kept ?? new Date().toISOString(), textVersion: CONSENT_VERSION, deleteOriginals: body.deleteOriginals !== false };
  await saveSpace(r.store, space.uid, space.doc);
  return json({ consent: space.doc.consent });
}
