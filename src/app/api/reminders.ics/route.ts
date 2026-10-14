import { buildCalendar } from "@/lib/ics";
import { keys } from "@/lib/keys";
import type { MemoryDoc } from "@/lib/memory";
import { publicUrl, ready } from "@/lib/server";
import { feedKeyMatches, parseFeedKey, type SpaceDoc } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The space's calendar feed (webcal-subscribable). A rotated key (delete-all) or a deleted space answers 410. */
export async function GET(req: Request) {
  const r = ready();
  if (!r.ok) return new Response("not configured", { status: 503 });
  const parsed = parseFeedKey(new URL(req.url).searchParams.get("k"));
  if (!parsed) return new Response("bad key", { status: 400 });
  const space = (await r.store.getJson<SpaceDoc>(keys.space(parsed.uid)))?.value;
  if (!space || !feedKeyMatches(space, parsed.feedKey)) return new Response("This calendar was deleted.", { status: 410 });
  const memory = (await r.store.getJson<MemoryDoc>(keys.memory(parsed.uid)))?.value;
  const body = buildCalendar(memory?.items ?? [], { baseUrl: publicUrl() });
  return new Response(body, {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store", "content-disposition": "inline; filename=hearth.ics" },
  });
}
