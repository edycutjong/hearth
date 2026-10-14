import { flags, json, loadSpace, notConfigured, ready } from "@/lib/server";
import { daysLeft, safeTimeZone } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open (or create) the visitor's anonymous space. Body: { timeZone }. */
export async function POST(req: Request) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const body = (await req.json().catch(() => ({}))) as { timeZone?: string };
  const space = await loadSpace(r.store, { create: true, timeZone: safeTimeZone(body.timeZone) });
  if (!space) return json({ error: "could not open a space" }, 500);
  return json({
    uid: space.uid.slice(0, 8),
    kept: space.doc.kept,
    daysLeft: daysLeft(space.doc),
    consent: space.doc.consent ?? null,
    tfOptIn: Boolean(space.doc.tfOptIn),
    zdrOn: flags.zdrOn(),
    zdrConfirmed: flags.zdrConfirmed(),
  });
}
