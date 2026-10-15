import { anchorFromFilename, formatDate, localDate, parseDate } from "@/lib/dates";
import { MAX_UPLOAD_BYTES, audioExt, keys, spaceTag } from "@/lib/keys";
import type { NoteMeta } from "@/lib/pipeline";
import { json, loadSpace, notConfigured, ready } from "@/lib/server";
import { newId } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES = 20;

interface FileIn {
  name: string;
  size: number;
  anchor?: string | null;
  anchorSource?: "filename" | "chat" | "upload";
  label?: string;
}

/**
 * Upload slots. Returns one presigned PUT per file for raw/<uid>/<note>.<ext>; the tag is inside the signature,
 * so the browser must send `x-amz-tagging` exactly as given. Only the audio leaves the device — a chat export's
 * text is parsed in the browser and never uploaded.
 */
export async function POST(req: Request) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const space = await loadSpace(r.store);
  if (!space) return json({ error: "Open Hearth first; no space yet." }, 404);
  if (!space.doc.consent) return json({ error: "Tick the consent first." }, 403);
  const body = (await req.json().catch(() => ({}))) as { files?: FileIn[] };
  const files = (body.files ?? []).slice(0, MAX_FILES + 1);
  if (!files.length) return json({ error: "No files." }, 400);
  if (files.length > MAX_FILES) return json({ error: `At most ${MAX_FILES} notes at a time.` }, 400);
  const tag = spaceTag(space.doc.kept);
  // "Today" is the user's own calendar day: a 02:00 upload in India is not yesterday's note.
  const today = localDate(new Date(), space.doc.timeZone);
  const out = [];
  for (const f of files) {
    const ext = audioExt(String(f.name ?? ""));
    if (!ext) return json({ error: `"${f.name}" isn't a voice note (opus, ogg, m4a, mp3, wav, aac, amr).` }, 400);
    if (!(f.size > 0 && f.size <= MAX_UPLOAD_BYTES)) return json({ error: `"${f.name}" is larger than 25 MB.` }, 400);
    const id = newId(6);
    const fromName = anchorFromFilename(f.name);
    const anchor = realDate(f.anchor) ? (f.anchor as string) : fromName ?? today;
    const meta: NoteMeta = {
      version: 1,
      id,
      name: String(f.name).slice(0, 120),
      ext,
      size: f.size,
      label: (f.label ?? "").trim().slice(0, 40) || "Family",
      anchor,
      anchorSource: f.anchor ? (f.anchorSource === "chat" ? "chat" : "filename") : fromName ? "filename" : "upload",
      uploaded: new Date().toISOString(),
      status: "uploading",
      raw: { state: "uploaded" },
    };
    await r.store.putJson(keys.meta(space.uid, id), meta, { tagging: tag });
    out.push({ id, putUrl: r.store.presignPut(keys.raw(space.uid, id, ext), 3600, tag), headers: { "x-amz-tagging": tag } });
  }
  return json({ notes: out });
}

/** A client-sent anchor must be a real calendar date within a year of today (the resolver dates reminders from it). */
function realDate(a: string | null | undefined): boolean {
  if (!a || !/^\d{4}-\d{2}-\d{2}$/.test(a)) return false;
  try {
    return formatDate(parseDate(a)) === a && Math.abs(parseDate(a).getTime() - Date.now()) < 366 * 86_400_000;
  } catch {
    return false;
  }
}
