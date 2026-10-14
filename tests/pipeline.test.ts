import { describe, expect, it } from "vitest";
import { PRICE_PER_HOUR, canSpend, emptySpend, phaseOf, reserve, settle, takeDaily, type SpendDoc } from "@/lib/caps";
import { keys } from "@/lib/keys";
import {
  backoffSeconds,
  deleteOriginal,
  dispatch,
  driftPasses,
  enqueue,
  holdsSlot,
  jobTimings,
  reconcileJob,
  sweepGrace,
  tickToken,
  type JobRecord,
  type NoteMeta,
} from "@/lib/pipeline";
import { UID, makeCtx, must, playWorker, seedNote, seedSpace } from "./helpers";

async function record(ctx: ReturnType<typeof makeCtx>, job: string) {
  return must((await ctx.store.getJson<JobRecord>(keys.job(UID, job)))?.value, "job record");
}
async function meta(ctx: ReturnType<typeof makeCtx>, id: string) {
  return must((await ctx.store.getJson<NoteMeta>(keys.meta(UID, id)))?.value, "meta");
}

describe("dispatch", () => {
  it("creates one Nebius job with the worker injected and every PUT tagged", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    expect(await dispatch(ctx)).toBe("dispatched");
    const run = [...ctx.backend.runs.values()][0];
    expect(run?.files.map((f) => f.containerPath)).toEqual(["/opt/hearth/worker.py", "/opt/hearth/run.sh", "/opt/hearth/requirements.txt"]);
    expect(run?.env.MODE).toBe("keep");
    const manifest = must((await ctx.store.getJson<{ notes: Array<{ put: { hct: { headers: Record<string, string> } } }>; tick_url: string }>(keys.jobManifest(UID, job)))?.value);
    expect(manifest.notes[0]?.put.hct.headers["x-amz-tagging"]).toBe("space=anon");
    expect(manifest.tick_url).toContain(`t=${tickToken("test-secret", UID, job)}`);
    expect((await record(ctx, job)).state).toBe("dispatched");
    expect((await meta(ctx, "aa000001")).status).toBe("processing");
    expect(await ctx.store.list(keys.queuePrefix())).toHaveLength(0);
  });

  it("runs one Hearth job at a time", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    await seedNote(ctx.store, "aa000002");
    await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await enqueue(ctx, UID, "keep", [{ id: "aa000002", ext: "opus" }]);
    expect(await dispatch(ctx)).toBe("dispatched");
    expect(await dispatch(ctx)).toBe("busy");
    expect(ctx.backend.runs.size).toBe(1);
  });

  it("waits with backoff when the shared region is full, without creating a job", async () => {
    const ctx = makeCtx();
    ctx.backend.foreign = 2;
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    expect(await dispatch(ctx)).toBe("backoff");
    expect(ctx.backend.runs.size).toBe(0);
    expect((await record(ctx, job)).history.at(-1)?.event).toMatch(/region full/);
  });

  it("does not wait on its own finished job while the Nebius listing still shows it", async () => {
    const ctx = makeCtx();
    ctx.backend.foreign = 1; // the D0 harness, or another app on the tenant
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    await seedNote(ctx.store, "aa000002");
    const first = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await enqueue(ctx, UID, "keep", [{ id: "aa000002", ext: "opus" }]);
    expect(await dispatch(ctx)).toBe("dispatched");
    await playWorker(ctx.store, UID, first.job);
    expect(must(await reconcileJob(ctx, UID, first.job)).state).toBe("done");
    const run = must([...ctx.backend.runs.values()][0], "first run");
    ctx.backend.finish(run.id);
    ctx.backend.stale.push({ id: run.id, name: run.name }); // the listing lags the instance release
    expect(await dispatch(ctx)).toBe("dispatched");
    expect([...ctx.backend.runs.values()][1]?.state).toBe("RUNNING");
  });

  it("counts every job that may hold an instance: in flight, the harness, other apps", () => {
    expect(holdsSlot({ name: "hearth-2026101400aabbcc" }, new Set(["2026101400aabbcc"]))).toBe(true);
    expect(holdsSlot({ name: "hearth-2026101400aabbcc" }, new Set())).toBe(false);
    expect(holdsSlot({ name: "hearth-d0-20261014t231930z-4vcpu-16gb" }, new Set())).toBe(true);
    expect(holdsSlot({ name: "faultline-9d33fada-r3-i172-bd522cc7c8c9-a1" }, new Set())).toBe(true);
  });

  it("treats a 429 on create as a requeue, releasing the reserved spend", async () => {
    const ctx = makeCtx();
    ctx.backend.throttle = 1;
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    expect(await dispatch(ctx)).toBe("backoff");
    const spend = must((await ctx.store.getJson<SpendDoc>(keys.spend()))?.value);
    expect(Object.keys(spend.reserved)).toHaveLength(0);
  });

  it("backs off 30 s doubling to 4 min", () => {
    expect([0, 1, 2, 3, 4, 5].map(backoffSeconds)).toEqual([30, 60, 120, 240, 240, 240]);
  });
});

describe("reconcile and finalize", () => {
  async function dispatched(drift = 0.02) {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await dispatch(ctx);
    return { ctx, job, drift };
  }

  it("keeps a note whose stored tokens match the report, and schedules the raw deletion after the grace", async () => {
    const { ctx, job } = await dispatched();
    await playWorker(ctx.store, UID, job);
    const rec = must(await reconcileJob(ctx, UID, job));
    expect(rec.state).toBe("done");
    const m = await meta(ctx, "aa000001");
    expect(m.status).toBe("kept");
    expect(m.kept?.driftPass).toBe(true);
    expect(m.raw.state).toBe("grace");
    expect((await ctx.store.head(keys.raw(UID, "aa000001", "opus"))).status).toBe(200);
    expect(await ctx.store.list(keys.activePrefix())).toHaveLength(0);
  });

  it("refuses tokens whose sha256 does not match, and keeps the original", async () => {
    const { ctx, job } = await dispatched();
    await playWorker(ctx.store, UID, job, () => ({ drift: 0.01, tamper: true }));
    await reconcileJob(ctx, UID, job);
    const m = await meta(ctx, "aa000001");
    expect(m.status).toBe("failed");
    expect(m.raw.state).toBe("kept_original");
    expect((await ctx.store.head(keys.original(UID, "aa000001", "opus"))).status).toBe(200);
    expect((await ctx.store.head(keys.raw(UID, "aa000001", "opus"))).status).toBe(404);
  });

  it("keeps the original when the round trip drifts past the gate, with the tag replaced", async () => {
    const { ctx, job } = await dispatched();
    await playWorker(ctx.store, UID, job, () => ({ drift: 0.12 }));
    await reconcileJob(ctx, UID, job);
    const m = await meta(ctx, "aa000001");
    expect(m.kept?.driftPass).toBe(false);
    expect(m.raw.state).toBe("kept_original");
    expect(m.raw.reason).toMatch(/12\.0 % of words/);
    expect(await ctx.store.getTags(keys.original(UID, "aa000001", "opus"))).toEqual({ space: "anon" });
  });

  it("requeues a job that ended in QuotaExceeded without spending an attempt", async () => {
    const ctx = makeCtx();
    ctx.backend.foreign = 1;
    ctx.backend.slots = 1; // the next create lands over the quota
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    ctx.regionSlots = 3; // our pre-check passes; Nebius disagrees, as it did for Faultline
    expect(await dispatch(ctx)).toBe("dispatched");
    const rec = must(await reconcileJob(ctx, UID, job));
    expect(rec.state).toBe("queued");
    expect(rec.attempts).toBe(1);
    expect(rec.history.at(-1)?.event).toMatch(/QuotaExceeded/);
    expect(await ctx.store.list(keys.queuePrefix())).toHaveLength(1);
  });

  it("retries a job that ended without a report once, then fails and keeps the original", async () => {
    const { ctx, job } = await dispatched();
    const first = [...ctx.backend.runs.keys()][0] as string;
    ctx.backend.finish(first);
    expect(must(await reconcileJob(ctx, UID, job)).state).toBe("queued");
    const later = new Date(Date.now() + 60_000);
    ctx.now = () => later;
    expect(await dispatch(ctx)).toBe("dispatched");
    const second = [...ctx.backend.runs.keys()][1] as string;
    ctx.backend.finish(second);
    expect(must(await reconcileJob(ctx, UID, job)).state).toBe("failed");
    const m = await meta(ctx, "aa000001");
    expect(m.status).toBe("failed");
    expect(m.raw.state).toBe("kept_original");
  });
});

describe("where a Job's time goes", () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  it("splits it from the Job's own report: queue, start-up, install, models, the notes", () => {
    const t = jobTimings(
      { created: "2026-10-14T23:20:00.000Z", dispatched: "2026-10-14T23:20:30.000Z" },
      {
        context: { t0: at("2026-10-14T23:23:10Z"), t_install: at("2026-10-14T23:23:30Z"), worker_start: at("2026-10-14T23:23:31Z") },
        load: { total_s: 95.04, prefetch_s: 71.2 },
        finished: at("2026-10-14T23:26:26Z"),
      },
    );
    expect(t).toEqual({ queueS: 30, startupS: 160, installS: 20, modelsS: 95, workS: 80, prefetchS: 71.2 });
  });

  it("leaves what the report does not carry as null instead of guessing", () => {
    expect(jobTimings({ created: "2026-10-14T23:20:00.000Z" }, {})).toEqual({
      queueS: null, startupS: null, installS: null, modelsS: null, workS: null, prefetchS: null,
    });
  });
});

describe("verified deletion", () => {
  it("deletes after the grace and proves it: raw and originals both HEAD 404", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await dispatch(ctx);
    await playWorker(ctx.store, UID, job);
    await reconcileJob(ctx, UID, job);
    expect(await sweepGrace(ctx, UID)).toBe(0);
    const later = new Date(Date.now() + 25 * 3_600_000);
    ctx.now = () => later;
    expect(await sweepGrace(ctx, UID)).toBe(1);
    const m = await meta(ctx, "aa000001");
    expect(m.raw).toMatchObject({ state: "deleted", rawHead: 404, originalHead: 404 });
  });

  it("'Delete original now' removes a kept original too", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    const m = await seedNote(ctx.store, "aa000001");
    await ctx.store.copy(keys.raw(UID, "aa000001", "opus"), keys.original(UID, "aa000001", "opus"), "space=anon");
    const after = await deleteOriginal(ctx, UID, m);
    expect(after.raw.state).toBe("deleted");
  });
});

describe("the drift gate (fixed prior)", () => {
  it("passes at <= 5 % per note and <= 30 % for every segment of >= 8 words", () => {
    expect(driftPasses(0.05, [{ words: 12, drift: 0.3 }])).toBe(true);
    expect(driftPasses(0.051, [])).toBe(false);
    expect(driftPasses(0.02, [{ words: 9, drift: 0.31 }])).toBe(false);
    expect(driftPasses(0.02, [{ words: 5, drift: 0.9 }])).toBe(true);
  });
});

describe("spend meter and caps", () => {
  it("prices the presets from the cpu-d3 list price", () => {
    expect(PRICE_PER_HOUR["4vcpu-16gb"]).toBeCloseTo(0.132, 6);
    expect(PRICE_PER_HOUR["8vcpu-32gb"]).toBeCloseTo(0.264, 6);
  });

  it("reserves the 1 h worst case and settles the real duration once", async () => {
    const ctx = makeCtx();
    const now = new Date("2026-10-15T10:00:00Z");
    expect((await reserve(ctx.store, "j1", "4vcpu-16gb", now)).ok).toBe(true);
    await settle(ctx.store, "j1", 0.25);
    await settle(ctx.store, "j1", 0.25);
    const doc = must((await ctx.store.getJson<SpendDoc>(keys.spend()))?.value);
    expect(doc.byDay["2026-10-15"]).toBeCloseTo(0.033, 5);
    expect(doc.reserved).toEqual({});
  });

  it("refuses past the build ceiling and the judging-day slice", () => {
    const doc = emptySpend();
    doc.byDay["2026-10-20"] = 9.95;
    expect(canSpend(doc, 0.132, "2026-10-21")).toEqual({ ok: false, reason: "budget_total" });
    const judging = emptySpend();
    judging.byDay["2026-12-03"] = 0.45;
    expect(canSpend(judging, 0.132, "2026-12-03")).toEqual({ ok: false, reason: "budget_day" });
    expect(canSpend(judging, 0.132, "2026-12-04").ok).toBe(true);
    expect(phaseOf("2026-12-16").name).toBe("closed");
  });

  it("caps new uploads per day, uid-free, unless the judge code is used", async () => {
    const ctx = makeCtx();
    const now = new Date("2026-12-02T08:00:00Z");
    for (let i = 0; i < 40; i += 1) expect(await takeDaily(ctx.store, "jobs", now)).toBe(true);
    expect(await takeDaily(ctx.store, "jobs", now)).toBe(false);
    expect(await takeDaily(ctx.store, "jobs", now, true)).toBe(true);
  });
});
