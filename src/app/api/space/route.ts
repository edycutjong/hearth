import { keys } from "@/lib/keys";
import { flags, json, loadSpace, notConfigured, ready, saveSpace, readBody } from "@/lib/server";
import { daysLeft, safeTimeZone } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open (or create) the visitor's anonymous space. Body: { timeZone, judge }. `judge` (from /?judge=1, the judge page's
 * "Open an empty space") makes a space that holds no note yet a judge space: notes up to 60 s, in any
 * language the speech model is transcription-ready for (the worker detects it); reminders stay Hindi-only.
 */
export async function POST(req: Request) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const body = await readBody<{ timeZone?: string; judge?: boolean }>(req);
  const space = await loadSpace(r.store, { create: true, timeZone: safeTimeZone(body.timeZone) });
  if (!space) return json({ error: "could not open a space" }, 500);
  if (body.judge === true && !space.doc.judge && !(await r.store.list(keys.notesPrefix(space.uid))).length) {
    space.doc.judge = true;
    await saveSpace(r.store, space.uid, space.doc);
  }
  return json({
    uid: space.uid.slice(0, 8),
    kept: space.doc.kept,
    daysLeft: daysLeft(space.doc),
    consent: space.doc.consent ?? null,
    tfOptIn: Boolean(space.doc.tfOptIn),
    judge: Boolean(space.doc.judge),
    zdrOn: flags.zdrOn(),
    zdrConfirmed: flags.zdrConfirmed(),
  });
}
