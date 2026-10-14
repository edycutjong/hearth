import { keys } from "@/lib/keys";
import { cancelJob } from "@/lib/nebius/jobs";
import type { JobRecord } from "@/lib/pipeline";
import { json, loadSpace, notConfigured, ready } from "@/lib/server";
import { listJobs } from "@/lib/space-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Delete everything: cancel the space's Job if one is running (so it cannot write back), remove every key under
 * raw/<uid>/, cache/<uid>/ and u/<uid>/ plus its queue entries, then LIST all three prefixes again and return the
 * listings, which must be empty. The space document goes too, so the calendar feed's key is gone (410).
 * Only the uid-free daily counters and the spend meter remain.
 */
export async function POST(req: Request) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const body = (await req.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== "delete") return json({ error: "confirm with { confirm: 'delete' }" }, 400);
  const space = await loadSpace(r.store);
  if (!space) return json({ error: "no space" }, 404);
  const cancelled: string[] = [];
  for (const job of await listJobs(r.store, space.uid)) {
    if ((job.state === "dispatched" || job.state === "running") && job.nebiusId) {
      await cancelJob(r.config, job.nebiusId).then(() => cancelled.push(job.nebiusId as string)).catch(() => undefined);
    }
    await r.store.delete(keys.active(job.job));
  }
  for (const q of await r.store.list(keys.queuePrefix())) if (q.key.endsWith(`-${space.uid}.json`)) await r.store.delete(q.key);
  let deleted = 0;
  for (const prefix of keys.spacePrefixes(space.uid)) {
    for (const obj of await r.store.list(prefix)) {
      await r.store.delete(obj.key);
      deleted += 1;
    }
  }
  const listings = await Promise.all(
    keys.spacePrefixes(space.uid).map(async (p) => ({ prefix: p.replace(space.uid, `${space.uid.slice(0, 8)}…`), count: (await r.store.list(p)).length })),
  );
  return json({ deleted, cancelledJobs: cancelled, listings, at: new Date().toISOString() });
}

export type { JobRecord };
