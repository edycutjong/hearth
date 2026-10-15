import { cookies } from "next/headers";
import { keys } from "@/lib/keys";
import { cancelJob, getJob, TERMINAL_STATES } from "@/lib/nebius/jobs";
import { settle } from "@/lib/caps";
import type { JobRecord } from "@/lib/pipeline";
import { json, loadSpace, notConfigured, ready, readBody } from "@/lib/server";
import { COOKIE } from "@/lib/space";
import { listJobs } from "@/lib/space-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Delete everything: cancel the space's Job if one is running (so it cannot write back), remove every key under
 * raw/<uid>/, cache/<uid>/ and u/<uid>/ plus its queue entries, then LIST all three prefixes again and return the
 * listings, which must be empty. The space document goes too, so the calendar feed's key is gone (410), and the
 * space cookie is cleared. A tombstone, written first, fences the space off from every other writer (src/lib/fence.ts);
 * a Job still running is cancelled and waited for (bounded). Afterwards only the uid-free daily counters, the spend
 * meter and that opaque tombstone remain, and the daily cron removes the tombstone after sweeping the prefixes again.
 */
export async function POST(req: Request) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const body = await readBody<{ confirm?: string }>(req);
  if (body.confirm !== "delete") return json({ error: "confirm with { confirm: 'delete' }" }, 400);
  const space = await loadSpace(r.store);
  if (!space) return json({ error: "no space" }, 404);
  // The fence goes up FIRST: from here on no reconcile, dispatch or memory pass writes into this space, and a Job
  // created in the meantime is cancelled. The daily cron sweeps the prefixes once more after the presigned URLs expire.
  await r.store.putJson(keys.reap(space.uid), { at: new Date().toISOString() });
  const cancelled: string[] = [];
  const stillRunning: string[] = [];
  for (const job of await listJobs(r.store, space.uid)) {
    if ((job.state === "dispatched" || job.state === "running" || job.state === "finalizing") && job.nebiusId) {
      await cancelJob(r.config, job.nebiusId).then(() => cancelled.push(job.nebiusId as string)).catch(() => undefined);
      // A cancelled Job may still write through its presigned URLs until it stops: wait for it (bounded).
      if (!(await untilTerminal(r.config, job.nebiusId))) stillRunning.push(job.nebiusId);
      const hours = Math.max(0, (Date.now() - Date.parse(job.dispatched ?? job.created)) / 3_600_000);
      await settle(r.store, job.job, hours).catch(() => undefined);
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
  // The space document is gone; forget its id too, so starting again opens a new space under a new id.
  (await cookies()).delete(COOKIE);
  return json({ deleted, cancelledJobs: cancelled, stillRunning, listings, at: new Date().toISOString() });
}

export type { JobRecord };

async function untilTerminal(config: Parameters<typeof getJob>[0], id: string, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const j = await getJob(config, id).catch(() => null);
    if (!j || TERMINAL_STATES.has(j.status.state)) return true;
    await new Promise((done) => setTimeout(done, 2_000));
  }
  return false;
}
