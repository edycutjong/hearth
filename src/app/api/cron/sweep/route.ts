import { reconcileActive, sweepGrace } from "@/lib/pipeline";
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
  if (want && req.headers.get("authorization") !== `Bearer ${want}`) return json({ error: "unauthorized" }, 401);
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const active = await reconcileActive(r.ctx).catch(() => -1);
  const spaces = new Set<string>();
  for (const obj of await r.store.list("raw/")) spaces.add(obj.key.split("/")[1] ?? "");
  let swept = 0;
  for (const uid of spaces) if (uid) swept += await sweepGrace(r.ctx, uid).catch(() => 0);
  return json({ active, spacesWithRaw: spaces.size, originalsDeleted: swept, at: new Date().toISOString() });
}
