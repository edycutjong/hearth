import { keys } from "@/lib/keys";
import { REAP_AFTER_SECONDS, reconcileActive, sweepGrace } from "@/lib/pipeline";
import { json, notConfigured, ready } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily (Vercel cron) and on demand: bring every in-flight Job forward, dispatch the queue, and delete originals
 * whose 24 h grace has passed. Protected by CRON_SECRET when set.
 */
export async function GET(req: Request) {
  const want = process.env.CRON_SECRET?.trim();
  if (!want && process.env.VERCEL_ENV === "production") return json({ error: "cron is not configured" }, 503);
  if (want && req.headers.get("authorization") !== `Bearer ${want}`) return json({ error: "unauthorized" }, 401);
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const active = await reconcileActive(r.ctx).catch(() => -1);
  const spaces = new Set<string>();
  for (const obj of await r.store.list("raw/")) spaces.add(obj.key.split("/")[1] ?? "");
  let swept = 0;
  for (const uid of spaces) if (uid) swept += await sweepGrace(r.ctx, uid).catch(() => 0);
  // Deleted spaces: once every presigned URL a cancelled Job held has expired, delete their prefixes once more.
  let reaped = 0;
  for (const t of await r.store.list(keys.reapPrefix())) {
    const uid = t.key.split("/").pop()?.replace(/\.json$/, "") ?? "";
    const at = (await r.store.getJson<{ at: string }>(t.key))?.value.at;
    if (!uid || !at || Date.now() - Date.parse(at) < REAP_AFTER_SECONDS * 1000) continue;
    for (const prefix of keys.spacePrefixes(uid)) for (const obj of await r.store.list(prefix)) await r.store.delete(obj.key);
    await r.store.delete(t.key);
    reaped += 1;
  }
  return json({ active, spacesWithRaw: spaces.size, originalsDeleted: swept, spacesReaped: reaped, at: new Date().toISOString() });
}
