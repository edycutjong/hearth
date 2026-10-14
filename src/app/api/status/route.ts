import { readDaily, utcDay, phaseOf } from "@/lib/caps";
import { keys } from "@/lib/keys";
import { queuePosition, reconcileSpace, sweepGrace } from "@/lib/pipeline";
import { flags, json, loadSpace, notConfigured, publicUrl, ready, tfConfig } from "@/lib/server";
import { daysLeft } from "@/lib/space";
import { listJobs, listNotes, pumpMemory, readMemory } from "@/lib/space-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Everything the app shows about the visitor's space. Polling it also moves the space forward: jobs in flight
 * are reconciled, due originals are deleted (and proven gone), and a few kept notes are remembered.
 */
export async function GET() {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const space = await loadSpace(r.store);
  if (!space) return json({ space: null });
  const errors: string[] = [];
  await reconcileSpace(r.ctx, space.uid).catch((e: unknown) => errors.push(`reconcile: ${String(e).slice(0, 160)}`));
  await sweepGrace(r.ctx, space.uid).catch((e: unknown) => errors.push(`grace: ${String(e).slice(0, 160)}`));
  await pumpMemory(r.store, tfConfig(), space.uid, { budgetMs: 25_000 }).catch((e: unknown) => errors.push(`memory: ${String(e).slice(0, 160)}`));
  const [notes, jobs, memory, daily] = await Promise.all([
    listNotes(r.store, space.uid),
    listJobs(r.store, space.uid),
    readMemory(r.store, space.uid),
    readDaily(r.store),
  ]);
  const queued = await Promise.all(
    jobs.filter((j) => j.state === "queued" && j.queueKey).map(async (j) => [j.job, await queuePosition(r.ctx, j.queueKey ?? "")] as const),
  );
  return json({
    space: {
      uid: space.uid.slice(0, 8),
      kept: space.doc.kept,
      daysLeft: daysLeft(space.doc),
      consent: space.doc.consent ?? null,
      tfOptIn: Boolean(space.doc.tfOptIn),
      judge: Boolean(space.doc.judge),
      timeZone: space.doc.timeZone,
      feedUrl: `${publicUrl()}/api/reminders.ics?k=${space.uid}.${space.doc.feedKey}`,
    },
    notes,
    jobs: jobs.slice(0, 20),
    queue: Object.fromEntries(queued),
    memory,
    caps: { ...daily, phase: phaseOf(utcDay()).name },
    flags: { zdrOn: flags.zdrOn(), zdrConfirmed: flags.zdrConfirmed(), tf: Boolean(tfConfig()) },
    errors,
    prefixes: keys.spacePrefixes(space.uid).map((p) => p.replace(space.uid, `${space.uid.slice(0, 8)}…`)),
  });
}
