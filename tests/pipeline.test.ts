import { describe, expect, it } from "vitest";
import { PRICE_PER_HOUR, canSpend, emptySpend, phaseOf, reserve, settle, settleStale, takeDaily, type SpendDoc } from "@/lib/caps";
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
    expect(run?.files.map((f) => f.containerPath)).toEqual(["/opt/hearth/run.sh", "/opt/hearth/worker.py.gz", "/opt/hearth/requirements.txt.gz"]);
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

  it("keeps a judge note's language detection and 60 s limit through a QuotaExceeded requeue", async () => {
    const ctx = makeCtx();
    ctx.backend.foreign = 1;
    ctx.backend.slots = 1;
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }], { lang: "detect", maxNoteSeconds: 60 });
    ctx.regionSlots = 3;
    expect(await dispatch(ctx)).toBe("dispatched");
    expect(must(await reconcileJob(ctx, UID, job)).state).toBe("queued");
    ctx.backend.foreign = 0;
    ctx.backend.slots = 2;
    const queued = must((await ctx.store.list(keys.queuePrefix()))[0]);
    const entry = must((await ctx.store.getJson<{ nextTry: string }>(queued.key))?.value);
    entry.nextTry = new Date(0).toISOString();
    await ctx.store.putJson(queued.key, entry);
    expect(await dispatch(ctx)).toBe("dispatched");
    const manifest = must((await ctx.store.getJson<{ lang: string; max_note_s: number }>(keys.jobManifest(UID, job)))?.value);
    expect([manifest.lang, manifest.max_note_s]).toEqual(["detect", 60]);
  });

  it("creates one Job when two requests dispatch at the same moment", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    await seedNote(ctx.store, "aa000002");
    await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await enqueue(ctx, UID, "keep", [{ id: "aa000002", ext: "opus" }]);
    const outcomes = await Promise.all([dispatch(ctx), dispatch(ctx), dispatch(ctx)]);
    expect(outcomes.filter((o) => o === "dispatched")).toHaveLength(1);
    expect(ctx.backend.runs.size).toBe(1);
  });

  it("waits instead of creating when the region cannot be read", async () => {
    const ctx = makeCtx();
    ctx.backend.failList = true;
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    expect(await dispatch(ctx)).toBe("backoff");
    expect(ctx.backend.runs.size).toBe(0);
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

describe("finalize under races, deferral and the watchdog", () => {
  it("finalizes once when a status poll and the tick arrive together", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await dispatch(ctx);
    await playWorker(ctx.store, UID, job);
    await Promise.all([reconcileJob(ctx, UID, job), reconcileJob(ctx, UID, job), reconcileJob(ctx, UID, job)]);
    const rec = await record(ctx, job);
    expect(rec.state).toBe("done");
    expect(rec.history.filter((h) => h.event.startsWith("report done"))).toHaveLength(1);
  });

  it("never turns a kept note back into a failed one when a Job reports again", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await dispatch(ctx);
    await playWorker(ctx.store, UID, job);
    await reconcileJob(ctx, UID, job);
    const done = await record(ctx, job);
    await ctx.store.putJson(keys.job(UID, job), { ...done, state: "running" }); // a stray second finalize
    await playWorker(ctx.store, UID, job, () => ({ drift: 0.02, status: "failed" }));
    await reconcileJob(ctx, UID, job);
    expect((await meta(ctx, "aa000001")).status).toBe("kept");
  });

  it("requeues notes the worker deferred, keeping what the entry asked for", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    await seedNote(ctx.store, "aa000002");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }, { id: "aa000002", ext: "opus" }], { lang: "detect", maxNoteSeconds: 60 });
    await dispatch(ctx);
    await playWorker(ctx.store, UID, job, (id) => (id === "aa000002" ? { drift: 0, status: "deferred" } : { drift: 0.02 }));
    await reconcileJob(ctx, UID, job);
    expect((await meta(ctx, "aa000001")).status).toBe("kept");
    expect((await meta(ctx, "aa000002")).status).toBe("queued");
    const q = await ctx.store.list(keys.queuePrefix());
    expect(q).toHaveLength(1);
    const entry = must((await ctx.store.getJson<{ notes: Array<{ id: string }>; lang: string; maxNoteSeconds: number }>(must(q[0]).key))?.value);
    expect(entry.notes.map((n) => n.id)).toEqual(["aa000002"]);
    expect([entry.lang, entry.maxNoteSeconds]).toEqual(["detect", 60]);
  });

  it("cancels a Job that never reached a terminal state after its timeout, and retries it", async () => {
    const t0 = new Date("2026-12-02T00:00:00Z");
    let now = t0;
    const ctx = makeCtx({ now: () => now });
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await dispatch(ctx);
    ctx.backend.failGet = true; // the job's state can no longer be read
    now = new Date(t0.getTime() + 20 * 60_000);
    expect(must(await reconcileJob(ctx, UID, job)).state).toBe("dispatched");
    now = new Date(t0.getTime() + 100 * 60_000);
    const rec = must(await reconcileJob(ctx, UID, job));
    expect(ctx.backend.cancelled).toHaveLength(1);
    expect(rec.state).toBe("queued");
    expect(await ctx.store.list(keys.activePrefix())).toHaveLength(0);
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
    expect(canSpend(judging, 0.132, "2026-12-03").ok).toBe(true); // under the slice so far: admitted (may overshoot by one Job)
    judging.byDay["2026-12-03"] = 0.5;
    expect(canSpend(judging, 0.132, "2026-12-03")).toEqual({ ok: false, reason: "budget_day" });
    expect(canSpend(judging, 0.132, "2026-12-04").ok).toBe(true);
    expect(phaseOf("2026-12-16").name).toBe("closed");
  });

  it("admits a Job on every day from Oct 31 to Dec 15 on an empty meter (a reservation is bigger than November's slice)", () => {
    for (let t = Date.parse("2026-10-31T12:00:00Z"); t <= Date.parse("2026-12-15T12:00:00Z"); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      expect(canSpend(emptySpend(), 0.132, day).ok, day).toBe(true);
    }
  });

  it("meters every attempt of a requeued Job and adds them up", async () => {
    const ctx = makeCtx();
    const now = new Date("2026-10-20T00:00:00Z");
    expect((await reserve(ctx.store, "jobA", "4vcpu-16gb", now)).ok).toBe(true);
    await settle(ctx.store, "jobA", 0.05); // attempt 1 ended (QuotaExceeded is settled at 0 in the pipeline)
    expect((await reserve(ctx.store, "jobA", "4vcpu-16gb", now)).ok).toBe(true); // attempt 2 reserves again
    let doc = must((await ctx.store.getJson<SpendDoc>("sys/caps/spend.json"))?.value);
    expect(doc.reserved.jobA).toBeDefined();
    await settle(ctx.store, "jobA", 0.1);
    await settle(ctx.store, "jobA", 0.1); // a repeated settle is a no-op
    doc = must((await ctx.store.getJson<SpendDoc>("sys/caps/spend.json"))?.value);
    expect(doc.settled.jobA?.hours).toBeCloseTo(0.15, 4);
    expect(doc.byDay["2026-10-20"]).toBeCloseTo(0.15 * PRICE_PER_HOUR["4vcpu-16gb"], 5);
  });

  it("settles a reservation whose Job is gone at its worst case, after the timeout", async () => {
    const ctx = makeCtx();
    await reserve(ctx.store, "orphan", "4vcpu-16gb", new Date("2026-12-02T00:00:00Z"));
    await reserve(ctx.store, "running", "4vcpu-16gb", new Date("2026-12-02T00:00:00Z"));
    expect(await settleStale(ctx.store, new Set(["running"]), new Date("2026-12-02T00:20:00Z"))).toBe(0);
    expect(await settleStale(ctx.store, new Set(["running"]), new Date("2026-12-02T01:40:00Z"))).toBe(1);
    const doc = must((await ctx.store.getJson<SpendDoc>("sys/caps/spend.json"))?.value);
    expect(doc.reserved.orphan).toBeUndefined();
    expect(doc.reserved.running).toBeDefined();
    expect(doc.settled.orphan?.usd).toBeCloseTo(0.132, 5);
  });

  it("caps anonymous Token Factory calls per day, uid-free", async () => {
    const ctx = makeCtx();
    const day = new Date("2026-12-03T10:00:00Z");
    const limit = phaseOf("2026-12-03").tfCallsPerDay;
    await ctx.store.putJson("sys/caps/2026-12-03.json", { jobs: 0, decodeJobs: 0, tfCalls: limit - 1 });
    expect(await takeDaily(ctx.store, "tfCalls", day)).toBe(true);
    expect(await takeDaily(ctx.store, "tfCalls", day)).toBe(false);
  });

  it("caps new uploads per day, uid-free, unless the judge code is used", async () => {
    const ctx = makeCtx();
    const now = new Date("2026-12-02T08:00:00Z");
    for (let i = 0; i < 40; i += 1) expect(await takeDaily(ctx.store, "jobs", now)).toBe(true);
    expect(await takeDaily(ctx.store, "jobs", now)).toBe(false);
    expect(await takeDaily(ctx.store, "jobs", now, true)).toBe(true);
  });
});
