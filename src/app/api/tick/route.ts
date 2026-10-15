import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { dispatch, reconcileJob, tickToken } from "@/lib/pipeline";
import { json, notConfigured, ready, tfConfig } from "@/lib/server";
import { pumpMemory } from "@/lib/space-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The worker's instance is still alive while it waits for this response; give it time to exit before the next create. */
const RELEASE_MS = 6_000;

/**
 * The worker's empty POST when it has written its report. The URL carries an HMAC of (space, job), so only the
 * job that was given it can prompt this; the handler itself only re-reads state, so a replay is harmless.
 * It answers as soon as the report is validated, so the Job stops (and stops billing) at once; remembering the
 * notes (Token Factory) and starting the next queued Job happen after the response.
 */
export async function POST(req: Request) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const url = new URL(req.url);
  const uid = url.searchParams.get("u") ?? "";
  const job = url.searchParams.get("j") ?? "";
  const t = url.searchParams.get("t") ?? "";
  const want = Buffer.from(tickToken(r.ctx.secret, uid, job));
  const got = Buffer.from(t);
  if (!/^[a-f0-9]{32}$/.test(uid) || !/^[a-z0-9]{8,40}$/.test(job) || want.length !== got.length || !timingSafeEqual(want, got)) {
    return json({ error: "bad tick" }, 403);
  }
  const rec = await reconcileJob(r.ctx, uid, job);
  const answered = Date.now();
  after(async () => {
    // The queue first (cheap and time-critical), once the finished Job's instance has had time to go; then memory.
    const wait = RELEASE_MS - (Date.now() - answered);
    if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    await dispatch(r.ctx).catch(() => "none");
    await pumpMemory(r.store, tfConfig(), uid, { budgetMs: 40_000 }).catch(() => 0);
  });
  return json({ job, state: rec?.state ?? null });
}
