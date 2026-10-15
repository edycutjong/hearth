import { keys } from "@/lib/keys";
import { recentCalls } from "@/lib/nebius/jobs";
import type { JobRecord, NoteMeta } from "@/lib/pipeline";
import { getSample } from "@/lib/sample";
import { json, loadSpace, ready } from "@/lib/server";
import { listJobs, readMemory } from "@/lib/space-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What actually ran: the sample's Job and, for a visitor, their own last run — ids, timings, bytes, hashes, HEADs. */
export async function GET() {
  const sample = getSample();
  const out: Record<string, unknown> = {
    deployed: { commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null },
    sample: sample.proof,
    sampleNotes: sample.notes.map((n) => ({ id: n.id, title: n.title, kept: n.kept, job: n.job, raw: n.raw })),
  };
  const r = ready();
  if (r.ok) {
    const space = await loadSpace(r.store);
    if (space) {
      const jobs: JobRecord[] = await listJobs(r.store, space.uid);
      const last = jobs.find((j) => j.state === "done" || j.state === "failed") ?? jobs[0] ?? null;
      const notes: NoteMeta[] = [];
      for (const n of last?.notes ?? []) {
        const m = (await r.store.getJson<NoteMeta>(keys.meta(space.uid, n.id)))?.value;
        if (m) notes.push(m);
      }
      const memory = await readMemory(r.store, space.uid);
      out.visitor = {
        job: last,
        notes,
        memory: memory ? { stats: memory.stats, calls: memory.calls.slice(-10), dropped: memory.dropped.slice(-10) } : null,
      };
    }
  }
  out.apiCalls = recentCalls().slice(-20);
  return json(out);
}
