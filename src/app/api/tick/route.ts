import { timingSafeEqual } from "node:crypto";
import { dispatch, reconcileJob, tickToken } from "@/lib/pipeline";
import { json, notConfigured, ready, tfConfig } from "@/lib/server";
import { pumpMemory } from "@/lib/space-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The worker's empty POST when it has written its report. The URL carries an HMAC of (space, job), so only the
 * job that was given it can prompt this; the handler itself only re-reads state, so a replay is harmless.
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
  await pumpMemory(r.store, tfConfig(), uid, { budgetMs: 35_000 }).catch(() => 0);
  await dispatch(r.ctx).catch(() => "none");
  return json({ job, state: rec?.state ?? null });
}
