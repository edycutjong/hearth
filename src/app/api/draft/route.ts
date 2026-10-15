import { takeDaily } from "@/lib/caps";
import { json, loadSpace, notConfigured, ready, tfConfig, readBody } from "@/lib/server";
import { memoryAllowsTf } from "@/lib/sample";
import { readMemory } from "@/lib/space-ops";
import { draftReply } from "@/lib/tf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** A reply draft (Hindi + English gloss) from the selected kept items. Hearth never sends it: there is a copy button. */
export async function POST(req: Request) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const tf = tfConfig();
  if (!tf) return json({ error: "Token Factory is not configured on this deployment." }, 503);
  const space = await loadSpace(r.store);
  if (!space) return json({ error: "no space" }, 404);
  if (!memoryAllowsTf(space.doc)) return json({ error: "Reminders are paused for this space." }, 403);
  const body = await readBody<{ items?: string[]; recipient?: string }>(req);
  const memory = await readMemory(r.store, space.uid);
  const items = (memory?.items ?? []).filter((i) => (body.items ?? []).includes(i.id) && i.state === "open");
  if (!items.length) return json({ error: "Pick at least one kept item." }, 400);
  if (!(await takeDaily(r.store, "tfCalls"))) return json({ error: "Drafting is paused for today (resets 00:00 UTC)." }, 429);
  const call = await draftReply(tf, items.map((i) => ({ what_en: i.what_en, quote: i.quote, due_label: i.dueLabel })), String(body.recipient ?? "Maa").slice(0, 30));
  if (!call.value) return json({ error: call.error ?? "no draft" }, 502);
  return json({ draft: call.value, requestId: call.requestId, label: "Machine-drafted. Read it before you send it yourself." });
}
