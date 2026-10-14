import { buildCalendar } from "@/lib/ics";
import { keys } from "@/lib/keys";
import { json, loadSpace, notConfigured, publicUrl, ready } from "@/lib/server";
import { listNotes, readMemory } from "@/lib/space-ops";
import { DECODE_SOURCE } from "@/lib/worker-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The export manifest. The BROWSER fetches every object by presigned GET and builds the zip itself, so the
 * tokens and transcripts never transit our server. Includes decode.py, which plays the notes without Hearth.
 */
export async function GET() {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const space = await loadSpace(r.store);
  if (!space) return json({ error: "no space" }, 404);
  const ttl = 1800;
  const files: Array<{ path: string; url: string }> = [];
  for (const m of await listNotes(r.store, space.uid)) {
    if (m.status !== "kept") continue;
    const base = `notes/${m.anchor}-${m.label.replace(/[^\p{L}\p{N}]+/gu, "_")}-${m.id}`;
    files.push({ path: `${base}.hct`, url: r.store.presignGet(keys.hct(space.uid, m.id), ttl) });
    files.push({ path: `${base}.transcript.json`, url: r.store.presignGet(keys.transcript(space.uid, m.id), ttl) });
    files.push({ path: `${base}.meta.json`, url: r.store.presignGet(keys.meta(space.uid, m.id), ttl) });
    for (const key of [keys.original(space.uid, m.id, m.ext), keys.raw(space.uid, m.id, m.ext)]) {
      if ((await r.store.head(key)).status === 200) {
        files.push({ path: `originals/${m.anchor}-${m.id}.${m.ext}`, url: r.store.presignGet(key, ttl) });
        break;
      }
    }
  }
  const memory = await readMemory(r.store, space.uid);
  return json({
    files,
    inline: [
      { path: "memory.json", text: JSON.stringify(memory ?? { items: [] }, null, 1) },
      { path: "reminders.ics", text: buildCalendar(memory?.items ?? [], { baseUrl: publicUrl() }) },
      { path: "decode.py", text: DECODE_SOURCE },
      {
        path: "README.txt",
        text: "Your Hearth export.\nnotes/*.hct are NVIDIA NanoCodec codes (13 x 12.5 per second, 11 bits each); run decode.py to turn them back into audio.\nnotes/*.transcript.json are the Hindi transcripts; memory.json holds the kept promises with their quotes; reminders.ics opens in any calendar.\noriginals/ holds any original you chose to keep.\n",
      },
    ],
  });
}
