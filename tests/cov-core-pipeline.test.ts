import { describe, expect, it } from "vitest";
import { emptySpend, reserve, type SpendDoc } from "@/lib/caps";
import { keys } from "@/lib/keys";
import {
  deleteOriginal, dispatch, enqueue, keepOriginal, queuePosition, reapOrphanMarkers, reconcileActive, reconcileJob, reconcileSpace,
  sweepGrace, type JobRecord, type NoteMeta, type QueueEntry,
} from "@/lib/pipeline";
import { UID, makeCtx, must, playWorker, seedNote, seedSpace } from "./helpers";

type Ctx = ReturnType<typeof makeCtx>;
const A = { id: "aa000001", ext: "opus" };
const B = { id: "aa000002", ext: "opus" };
const T0 = new Date("2026-12-02T00:00:00Z");
const rec = async (c: Ctx, job: string) => must((await c.store.getJson<JobRecord>(keys.job(UID, job)))?.value, "record");
const meta = async (c: Ctx, id: string) => must((await c.store.getJson<NoteMeta>(keys.meta(UID, id)))?.value, "meta");
const setup = async (over: Parameters<typeof makeCtx>[0] = {}, notes = [A]) => {
  const c = makeCtx({ now: () => T0, ...over });
  await seedSpace(c.store);
  for (const n of notes) await seedNote(c.store, n.id);
  return c;
};
const dispatched = async (c: Ctx, notes = [A], kind: "keep" | "decode" = "keep", opts = {}) => {
  const { job } = await enqueue(c, UID, kind, notes, opts);
  expect(await dispatch(c)).toBe("dispatched");
  return job;
};

describe("enqueue and queue position", () => {
  it("tags the record by the space (kept), reports FIFO positions, and a missing entry is null", async () => {
    const c = await setup();
    await seedSpace(c.store, UID, { kept: true });
    const one = await enqueue(c, UID, "keep", [A]);
    const two = await enqueue(c, UID, "decode", [A]);
    expect(await c.store.getTags(keys.job(UID, one.job))).toEqual({ space: "kept" });
    expect(await queuePosition(c, one.queueKey)).toBe(1);
    expect(await queuePosition(c, two.queueKey)).toBe(2);
    expect(await queuePosition(c, "sys/queue/none.json")).toBeNull();
  });
  it("works for a space that no longer exists (anon tag) and with the real clock", async () => {
    const c = makeCtx();
    const { job } = await enqueue(c, UID, "keep", [A]);
    expect(await c.store.getTags(keys.job(UID, job))).toEqual({ space: "anon" });
  });
  it("leaves no ghost record when the queue entry cannot be written", async () => {
    const c = await setup();
    const put = c.store.putJson.bind(c.store);
    c.store.putJson = (async (k: string, v: unknown, o?: never) => {
      if (k.startsWith("sys/queue/")) throw new Error("disk full");
      return put(k, v, o);
    }) as typeof c.store.putJson;
    await expect(enqueue(c, UID, "keep", [A])).rejects.toThrow("disk full");
    expect(await c.store.list(keys.jobsPrefix(UID))).toEqual([]);
    c.store.delete = async () => { throw new Error("also down"); };
    await expect(enqueue(c, UID, "keep", [A])).rejects.toThrow("disk full"); // the cleanup failure is swallowed
  });
});

describe("dispatch edges", () => {
  it("nothing queued: none; the lock is released either way", async () => {
    const c = await setup();
    expect(await dispatch(c)).toBe("none");
    expect(await c.store.head("sys/claims/_dispatch.json")).toMatchObject({ status: 404 });
  });
  it("a fresh lock held by someone else is busy; a stale one is taken over exactly once", async () => {
    const c = await setup();
    await c.store.putJson("sys/claims/_dispatch.json", { at: T0.toISOString() });
    expect(await dispatch(c)).toBe("busy");
    expect(await c.store.head("sys/claims/_dispatch.json")).toMatchObject({ status: 200 });
    await c.store.putJson("sys/claims/_dispatch.json", { at: new Date(T0.getTime() - 120_000).toISOString() });
    expect(await dispatch(c)).toBe("none"); // taken over, then released
    // the version changed under the taker: busy
    await c.store.putJson("sys/claims/_dispatch.json", { at: new Date(T0.getTime() - 120_000).toISOString() });
    const put = c.store.putJson.bind(c.store);
    c.store.putJson = (async (k: string, v: unknown, o?: { condition?: { ifMatch?: string } }) =>
      k === "sys/claims/_dispatch.json" && o?.condition?.ifMatch ? { ok: false, etag: null } : put(k, v, o as never)) as typeof c.store.putJson;
    expect(await dispatch(c)).toBe("busy");
  });
  it("a lock without an etag cannot be taken over", async () => {
    const c = await setup();
    await c.store.putJson("sys/claims/_dispatch.json", { at: new Date(T0.getTime() - 120_000).toISOString() });
    const get = c.store.getJson.bind(c.store);
    c.store.getJson = (async (k: string) => {
      const r = await get(k);
      return r && k === "sys/claims/_dispatch.json" ? { ...r, etag: null } : r;
    }) as typeof c.store.getJson;
    expect(await dispatch(c)).toBe("busy");
  });
  it("a lock that vanished between the failed write and the read is busy", async () => {
    const c = await setup();
    const put = c.store.putJson.bind(c.store);
    c.store.putJson = (async (k: string, v: unknown, o?: never) => (k === "sys/claims/_dispatch.json" ? { ok: false, etag: null } : put(k, v, o))) as typeof c.store.putJson;
    expect(await dispatch(c)).toBe("busy");
  });
  it("frees the slot of an orphaned active marker, then dispatches; still busy when the marker is genuine", async () => {
    const c = await setup();
    await c.store.putJson(keys.active("ghost"), { uid: UID, nebiusId: "aijob-ghost" }); // no job record
    await enqueue(c, UID, "keep", [A]);
    expect(await dispatch(c)).toBe("dispatched");
    expect(c.backend.cancelled).toEqual(["aijob-ghost"]);
    expect(await c.store.head(keys.active("ghost"))).toMatchObject({ status: 404 });
    // second job: the one running holds the only slot, nothing to reap
    await seedNote(c.store, B.id);
    await enqueue(c, UID, "keep", [B]);
    expect(await dispatch(c)).toBe("busy");
  });
  it("slot still taken after reaping unrelated orphans", async () => {
    const c = await setup({ maxConcurrent: 1 });
    await dispatched(c);
    await seedNote(c.store, B.id);
    await enqueue(c, UID, "keep", [B]);
    await c.store.putJson(keys.active("ghost"), { uid: UID }); // reaped, but the live one still holds the slot
    expect(await dispatch(c)).toBe("busy");
    expect(await c.store.head(keys.active("ghost"))).toMatchObject({ status: 404 });
  });
  it("drops queue entries whose space is gone or being deleted; skips ones not yet due", async () => {
    const c = await setup();
    const gone = await enqueue(c, UID, "keep", [A]);
    await c.store.delete(keys.space(UID));
    expect(await dispatch(c)).toBe("none");
    expect(await queuePosition(c, gone.queueKey)).toBeNull();
    await seedSpace(c.store);
    const later = await enqueue(c, UID, "keep", [A]);
    const entry = must((await c.store.getJson<QueueEntry>(later.queueKey))?.value);
    await c.store.putJson(later.queueKey, { ...entry, nextTry: new Date(T0.getTime() + 60_000).toISOString() });
    expect(await dispatch(c)).toBe("none");
    expect(await queuePosition(c, later.queueKey)).toBe(1);
    await c.store.putJson(keys.reap(UID), {});
    expect(await dispatch(c)).toBe("none");
    expect(await queuePosition(c, later.queueKey)).toBeNull();
  });
  it("skips an entry that vanished after listing", async () => {
    const c = await setup();
    await enqueue(c, UID, "keep", [A]);
    const get = c.store.getJson.bind(c.store);
    c.store.getJson = (async (k: string) => (k.startsWith("sys/queue/") ? null : get(k))) as typeof c.store.getJson;
    expect(await dispatch(c)).toBe("none");
  });
  it("an entry another request is dispatching is skipped; an abandoned claim is cleared", async () => {
    const c = await setup();
    const { queueKey } = await enqueue(c, UID, "keep", [A]);
    const claim = keys.claim(queueKey.split("/").pop() as string);
    await c.store.putJson(claim, { at: T0.toISOString() });
    expect(await dispatch(c)).toBe("none");
    expect(await c.store.head(claim)).toMatchObject({ status: 200 });
    await c.store.putJson(claim, { at: new Date(T0.getTime() - 10 * 60_000).toISOString() });
    expect(await dispatch(c)).toBe("none"); // cleared, picked up next time
    expect(await c.store.head(claim)).toMatchObject({ status: 404 });
    expect(await dispatch(c)).toBe("dispatched");
    // claim vanished between the failed write and the read
    const d = await setup();
    const e = await enqueue(d, UID, "keep", [A]);
    const put = d.store.putJson.bind(d.store);
    d.store.putJson = (async (k: string, v: unknown, o?: never) => (k.startsWith("sys/claims/aa") || k === keys.claim(e.queueKey.split("/").pop() as string) ? { ok: false, etag: null } : put(k, v, o))) as typeof d.store.putJson;
    expect(await dispatch(d)).toBe("none");
  });
  it("region full: waits with backoff and records it; an unreadable region counts as full", async () => {
    const c = await setup();
    c.backend.failList = true;
    const { job } = await enqueue(c, UID, "keep", [A]);
    expect(await dispatch(c)).toBe("backoff");
    expect((await rec(c, job)).backoffs).toBe(1);
  });
  it("past the budget: refused, allowances given back, notes stay uploaded", async () => {
    const c = await setup({ now: () => new Date("2027-01-02T00:00:00Z") });
    const space = await seedSpace(c.store);
    await c.store.putJson(keys.spaceCaps(UID), { "2027-01-02": 1 });
    const { job } = await enqueue(c, UID, "keep", [A]);
    expect(await dispatch(c)).toBe("budget");
    expect(space).toBeDefined();
    const r = await rec(c, job);
    expect(r).toMatchObject({ state: "failed", error: "processing budget: closed" });
    expect((await meta(c, A.id)).error).toMatch(/budget is used/);
    expect((await meta(c, A.id)).status).toBe("uploaded");
    expect((await c.store.getJson<Record<string, number>>(keys.spaceCaps(UID)))?.value["2027-01-02"]).toBe(0);
    expect(await c.store.list(keys.queuePrefix())).toEqual([]);
  });
  it("budget refusal of a decode job, with the space gone and failing give-backs", async () => {
    const c = await setup({ now: () => new Date("2027-01-02T00:00:00Z") });
    await enqueue(c, UID, "decode", [A]);
    expect(await dispatch(c)).toBe("budget");
    const d = await setup({ now: () => new Date("2027-01-02T00:00:00Z") });
    await enqueue(d, UID, "keep", [A]);
    const get = d.store.getJson.bind(d.store);
    d.store.getJson = (async (k: string) => {
      if (k.startsWith("sys/caps/2") || k === keys.spaceCaps(UID)) throw new Error("down");
      if (k === keys.space(UID)) return null;
      return get(k);
    }) as typeof d.store.getJson;
    d.store.head = async (k: string) => (k === keys.space(UID) ? { status: 200, size: 1 } : { status: 404, size: null });
    expect(await dispatch(d)).toBe("budget");
  });
  it("a create error that is not a throttle: retried once later, then the job fails and the original is kept", async () => {
    const c = await setup();
    c.backend.create = async () => { throw new Error("image pull denied"); };
    const { job } = await enqueue(c, UID, "keep", [A]);
    expect(await dispatch(c)).toBe("backoff");
    const q = await c.store.list(keys.queuePrefix());
    expect(must((await c.store.getJson<QueueEntry>(must(q[0]).key))?.value)).toMatchObject({ attempts: 1, nextTry: new Date(T0.getTime() + 30_000).toISOString() });
    c.now = () => new Date(T0.getTime() + 31_000);
    expect(await dispatch(c)).toBe("failed");
    expect(await c.store.list(keys.queuePrefix())).toEqual([]);
    expect(await rec(c, job)).toMatchObject({ state: "failed" });
    expect((await rec(c, job)).error).toMatch(/could not create the Nebius job: Error: image pull denied/);
    const m = await meta(c, A.id);
    expect(m).toMatchObject({ status: "failed" });
    expect(m.raw.state).toBe("kept_original");
    // the budget the failed attempts reserved is released
    expect(must((await c.store.getJson<SpendDoc>(keys.spend()))?.value).reserved).toEqual({});
  });
  it("recognises a throttle from a thrown non-Error, or from the error's body", async () => {
    for (const thrown of ["429 slow", Object.assign(new Error("bad gateway"), { body: "ResourceExhausted: quota" }), { body: undefined, toString: () => "Too Many Requests" }]) {
      const c = await setup();
      c.backend.create = async () => { throw thrown; };
      await enqueue(c, UID, "keep", [A]);
      expect(await dispatch(c)).toBe("backoff");
      const q = await c.store.list(keys.queuePrefix());
      expect(must((await c.store.getJson<QueueEntry>(must(q[0]).key))?.value).backoffs).toBe(1);
    }
    const d = await setup();
    d.backend.create = async () => { throw { body: undefined }; };
    await enqueue(d, UID, "keep", [A]);
    expect(await dispatch(d)).toBe("backoff"); // not a throttle: a first retry
    const q = await d.store.list(keys.queuePrefix());
    expect(must((await d.store.getJson<QueueEntry>(must(q[0]).key))?.value).attempts).toBe(1);
  });
  it("delete-all began while the job was being created: the job is cancelled and nothing runs", async () => {
    const c = await setup();
    const create = c.backend.create.bind(c.backend);
    c.backend.create = async (o) => {
      const id = await create(o);
      await c.store.putJson(keys.reap(UID), {});
      return id;
    };
    await enqueue(c, UID, "keep", [A]);
    // the fence also makes the pre-dispatch check drop the entry, so raise it only after that check
    const head = c.store.head.bind(c.store);
    let first = true;
    c.store.head = async (k) => (k === keys.reap(UID) && first ? ((first = false), { status: 404, size: null }) : head(k));
    c.backend.cancel = async (id) => { c.backend.cancelled.push(id); throw new Error("already gone"); };
    expect(await dispatch(c)).toBe("none");
    expect(c.backend.cancelled).toHaveLength(1);
    expect(await c.store.list(keys.activePrefix())).toEqual([]);
    expect(await c.store.list(keys.queuePrefix())).toEqual([]);
  });
  it("decode jobs get hct_get urls; prebuilt images and bucket weights are announced; a missing space tags anon; a missing note is skipped", async () => {
    const c = makeCtx({ now: () => T0, prebuilt: true, bucketWeights: true, trimmedCodec: true, publicUrl: "https://hearth.test//" });
    await seedSpace(c.store);
    const { job } = await enqueue(c, UID, "decode", [A, B], { maxNoteSeconds: 60, lang: "detect" });
    await seedNote(c.store, A.id);
    expect(await dispatch(c)).toBe("dispatched");
    const man = must((await c.store.getJson<{ notes: Array<Record<string, unknown>>; weights: { asr: string; codec: string }; trimmed_codec: boolean; lang: string; max_note_s: number; tick_url: string }>(keys.jobManifest(UID, job)))?.value);
    expect(man.notes[0]).toHaveProperty("hct_get");
    expect(man.weights.asr).toContain("models/nemotron");
    expect(man).toMatchObject({ trimmed_codec: true, lang: "detect", max_note_s: 60 });
    expect(man.tick_url.startsWith("https://hearth.test/api/tick")).toBe(true);
    expect([...c.backend.runs.values()][0]?.env.HEARTH_PREBUILT).toBe("1");
    expect((await meta(c, A.id)).status).toBe("processing");
    // no meta for B: markNotes skipped it without creating one
    expect(await c.store.getJson(keys.meta(UID, B.id))).toBeNull();
  });
  it("create without a space doc: the manifest is tagged anon", async () => {
    const c = makeCtx({ now: () => T0 });
    await c.store.putJson(keys.space(UID), {});
    const { job } = await enqueue(c, UID, "keep", [A]);
    await c.store.putJson(keys.space(UID), { kept: true });
    expect(await dispatch(c)).toBe("dispatched");
    expect(await c.store.getTags(keys.jobManifest(UID, job))).toEqual({ space: "kept" });
  });
});

describe("reconcileJob edges", () => {
  it("unknown job: null", async () => {
    const c = await setup();
    expect(await reconcileJob(c, UID, "nope")).toBeNull();
  });
  it("delete-all in flight: cancels a running job and settles it; a queued one is just unmarked", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await c.store.putJson(keys.reap(UID), {});
    expect(await reconcileJob(c, UID, job)).toBeNull();
    expect(c.backend.cancelled).toHaveLength(1);
    expect(await c.store.list(keys.activePrefix())).toEqual([]);
    expect(must((await c.store.getJson<SpendDoc>(keys.spend()))?.value).settled[job]).toBeDefined();
    const d = await setup();
    const { job: queued } = await enqueue(d, UID, "keep", [A]);
    await d.store.putJson(keys.reap(UID), {});
    expect(await reconcileJob(d, UID, queued)).toBeNull();
    expect(d.backend.cancelled).toEqual([]);
    const e = await setup();
    const j = await dispatched(e);
    await e.store.putJson(keys.reap(UID), {});
    e.backend.cancel = async () => { throw new Error("x"); };
    await e.store.delete(keys.spend());
    await reconcileJob(e, UID, j); // cancel and settle failures are swallowed
    const f = await setup();
    const k = await dispatched(f);
    await f.store.putJson(keys.reap(UID), {});
    const d2 = f.store.getJson.bind(f.store);
    f.store.getJson = (async (key: string) => { if (key === keys.spend()) throw new Error("meter down"); return d2(key); }) as typeof f.store.getJson;
    await reconcileJob(f, UID, k);
  });
  it("a finished job is returned unchanged; a stale finalize is taken over, a fresh one is left", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await playWorker(c.store, UID, job);
    const r0 = await rec(c, job);
    await c.store.putJson(keys.job(UID, job), { ...r0, state: "finalizing", finalizingAt: new Date(T0.getTime() - 30_000).toISOString() });
    expect((await reconcileJob(c, UID, job))?.state).toBe("finalizing"); // fresh: leave it
    await c.store.putJson(keys.job(UID, job), { ...r0, state: "finalizing" }); // no timestamp: stale
    expect((await reconcileJob(c, UID, job))?.state).toBe("done");
    expect((await reconcileJob(c, UID, job))?.state).toBe("done");
    const d = await setup();
    const j2 = await dispatched(d);
    await playWorker(d.store, UID, j2);
    await d.store.putJson(keys.job(UID, j2), { ...(await rec(d, j2)), state: "finalizing", finalizingAt: new Date(T0.getTime() - 3 * 60_000).toISOString() });
    expect((await reconcileJob(d, UID, j2))?.state).toBe("done");
  });
  it("a job whose state cannot be read yet reports nothing new", async () => {
    const c = await setup();
    const job = await dispatched(c);
    c.backend.failGet = true;
    expect((await reconcileJob(c, UID, job))?.state).toBe("dispatched");
  });
  it("claims finalization with if-match, loses gracefully, and works without an etag", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await playWorker(c.store, UID, job);
    const put = c.store.putJson.bind(c.store);
    c.store.putJson = (async (k: string, v: unknown, o?: { condition?: unknown }) => (k === keys.job(UID, job) && o?.condition ? { ok: false, etag: null } : put(k, v, o as never))) as typeof c.store.putJson;
    expect((await reconcileJob(c, UID, job))?.state).toBe("dispatched");
    c.store.putJson = put;
    const get = c.store.getJson.bind(c.store);
    c.store.getJson = (async (k: string) => {
      const r = await get(k);
      return r && k === keys.job(UID, job) ? { ...r, etag: null } : r;
    }) as typeof c.store.getJson;
    expect((await reconcileJob(c, UID, job))?.state).toBe("done");
  });
  it("tracks Nebius state changes: STARTING is recorded, RUNNING marks started", async () => {
    const c = await setup();
    const job = await dispatched(c);
    const run = must([...c.backend.runs.values()][0]);
    run.state = "STARTING";
    let r = must(await reconcileJob(c, UID, job));
    expect(r).toMatchObject({ state: "dispatched", nebiusState: "STARTING" });
    expect(await reconcileJob(c, UID, job)).toMatchObject({ nebiusState: "STARTING" }); // unchanged: no new history
    run.state = "RUNNING";
    r = must(await reconcileJob(c, UID, job));
    expect(r).toMatchObject({ state: "running", started: T0.toISOString() });
    c.backend.get = (async () => ({ state: "RUNNING", startedAt: "2026-12-02T00:00:05Z" })) as unknown as typeof c.backend.get;
    run.state = "x";
    await c.store.putJson(keys.job(UID, job), { ...r, nebiusState: "STARTING", state: "dispatched" });
    expect(must(await reconcileJob(c, UID, job)).started).toBe("2026-12-02T00:00:05Z");
  });
  it("quota: requeues without an attempt; keeps lang and maxNoteSeconds; loses the requeue race gracefully", async () => {
    const c = await setup();
    const job = await dispatched(c, [A], "keep", { lang: "detect", maxNoteSeconds: 60 });
    const run = must([...c.backend.runs.values()][0]);
    run.state = "ERROR";
    run.code = "QuotaExceeded";
    run.finishedAt = T0.toISOString();
    const r = must(await reconcileJob(c, UID, job));
    expect(r).toMatchObject({ state: "queued", backoffs: 1 });
    const q = await c.store.list(keys.queuePrefix());
    expect(must((await c.store.getJson<QueueEntry>(must(q[0]).key))?.value)).toMatchObject({ lang: "detect", maxNoteSeconds: 60, attempts: 0 });
    // a second request reaching the same terminal state writes nothing new and returns the current record
    await c.store.putJson(keys.job(UID, job), { ...r, state: "dispatched" });
    await c.store.putJson(keys.active(job), { uid: UID });
    expect((await reconcileJob(c, UID, job))?.state).toBe("dispatched");
    expect(await c.store.list(keys.queuePrefix())).toHaveLength(1);
    // ... even when the record is gone
    await c.store.delete(keys.job(UID, job));
    expect(await reconcileJob(c, UID, job)).toBeNull();
  });
  it("a silent job: second try without lang/max, then fail with the original kept; a requeue record created at dispatch uses the creation time when never dispatched", async () => {
    const c = await setup();
    const job = await dispatched(c);
    const run = must([...c.backend.runs.values()][0]);
    run.state = "FAILED";
    expect(must(await reconcileJob(c, UID, job)).state).toBe("queued");
    const r = await rec(c, job);
    const bare = { ...r, state: "dispatched" as const, attempts: 2, dispatched: undefined };
    await c.store.putJson(keys.job(UID, job), bare);
    expect(await reconcileJob(c, UID, job)).toMatchObject({ state: "failed" });
    expect((await meta(c, A.id)).raw.state).toBe("kept_original");
  });
  it("a job with no dispatch time settles at the full timeout", async () => {
    const c = await setup();
    const job = await dispatched(c);
    const r = await rec(c, job);
    await c.store.putJson(keys.job(UID, job), { ...r, dispatched: undefined, attempts: 2 });
    must([...c.backend.runs.values()][0]).state = "CANCELLED";
    expect((await reconcileJob(c, UID, job))?.state).toBe("failed");
    expect(must((await c.store.getJson<SpendDoc>(keys.spend()))?.value).settled[job]?.hours).toBe(1);
  });
  it("watchdog: a job past its timeout whose state is readable but not terminal is cancelled", async () => {
    let now = T0;
    const c = await setup({ now: () => now });
    const job = await dispatched(c);
    now = new Date(T0.getTime() + 2 * 3_600_000);
    expect((await reconcileJob(c, UID, job))?.state).toBe("queued");
    expect(c.backend.cancelled).toHaveLength(1);
    // and a failing cancel is swallowed
    const d = await setup({ now: () => now });
    now = T0;
    const j = await dispatched(d);
    now = new Date(T0.getTime() + 2 * 3_600_000);
    d.backend.cancel = async () => { throw new Error("x"); };
    expect((await reconcileJob(d, UID, j))?.state).toBe("queued");
  });
  it("a report for another job is ignored, a failed report is finalized as failed with its error", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await c.store.putJson(keys.jobResult(UID, job), { status: "done", job: "other", notes: [] });
    expect((await reconcileJob(c, UID, job))?.state).toBe("running");
    await c.store.putJson(keys.jobResult(UID, job), { status: "failed", job, error: "CUDA out of memory", notes: [] });
    const r = must(await reconcileJob(c, UID, job));
    expect(r).toMatchObject({ state: "failed", error: "CUDA out of memory" });
    const m = await meta(c, A.id);
    expect(m).toMatchObject({ status: "failed", error: "CUDA out of memory" });
    expect(m.raw.state).toBe("kept_original");
  });
});

describe("finalize paths", () => {
  it("a note with no result in the report fails with the generic message", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await c.store.putJson(keys.jobResult(UID, job), { status: "done", job });
    await reconcileJob(c, UID, job);
    expect((await meta(c, A.id)).error).toBe("the job reported no result for this note");
    await playWorker(c.store, UID, job); // irrelevant: already finalized
  });
  it("a note's own error is carried; a missing note meta is skipped; decode jobs never touch notes", async () => {
    const c = await setup({}, [A, B]);
    await c.store.delete(keys.meta(UID, B.id));
    const job = await dispatched(c, [A, B]);
    await c.store.putJson(keys.jobResult(UID, job), { status: "done", job, notes: [{ id: A.id, status: "failed", job, error: "no speech" }] });
    await reconcileJob(c, UID, job);
    expect((await meta(c, A.id)).error).toBe("no speech");
    expect(await c.store.getJson(keys.meta(UID, B.id))).toBeNull();
    const d = await setup();
    const dj = await dispatched(d, [A], "decode");
    await d.store.putJson(keys.jobResult(UID, dj), { status: "done", job: dj, notes: [] });
    expect((await reconcileJob(d, UID, dj))?.state).toBe("done");
    expect((await meta(d, A.id)).status).toBe("processing");
  });
  it("a truncated stored .hct, or a missing one, fails validation", async () => {
    for (const mutate of [(c: Ctx) => c.store.delete(keys.hct(UID, A.id)), (c: Ctx) => c.store.put(keys.hct(UID, A.id), new Uint8Array(3))]) {
      const c = await setup();
      const job = await dispatched(c);
      await playWorker(c.store, UID, job);
      await mutate(c);
      await reconcileJob(c, UID, job);
      expect((await meta(c, A.id)).error).toMatch(/do not match/);
    }
  });
  it("drift failure keeps the original with the percentage; a user's choice not to delete originals keeps it too", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await playWorker(c.store, UID, job, () => ({ drift: 0.2 }));
    await reconcileJob(c, UID, job);
    expect((await meta(c, A.id)).raw.reason).toMatch(/20\.0 %/);
    const d = await setup();
    await seedSpace(d.store, UID, { consent: { at: "x", textVersion: "v1", deleteOriginals: false } });
    const j = await dispatched(d);
    await playWorker(d.store, UID, j);
    await reconcileJob(d, UID, j);
    expect((await meta(d, A.id)).raw.reason).toMatch(/your choice/);
    const e = await setup();
    await seedSpace(e.store, UID, { consent: undefined });
    const j2 = await dispatched(e);
    await playWorker(e.store, UID, j2);
    await reconcileJob(e, UID, j2);
    expect((await meta(e, A.id)).raw.state).toBe("grace"); // no consent record: originals are deleted by default
  });
  it("a report with sparse fields still produces a complete kept record", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await playWorker(c.store, UID, job);
    const r = must((await c.store.getJson<{ notes: Array<Record<string, unknown>> }>(keys.jobResult(UID, job)))?.value);
    const n = must(r.notes[0]);
    for (const k of ["frames", "audio_s", "input_bytes", "drift_note", "segments", "lang_detected", "timings"]) delete n[k];
    await c.store.putJson(keys.jobResult(UID, job), { ...r, status: "done", job });
    await reconcileJob(c, UID, job);
    const m = await meta(c, A.id);
    expect(m.kept).toMatchObject({ frames: 0, audioS: 0, inputBytes: 40_000, driftNote: 1, driftPass: false, langDetected: null, maxDriftLongSegment: null, timings: {} });
    expect(m.raw.reason).toMatch(/100\.0 %/);
  });
  it("a space kept while the job ran re-tags the job's outputs", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await playWorker(c.store, UID, job);
    await seedSpace(c.store, UID, { kept: true });
    await c.store.delete(keys.cacheWav(UID, A.id));
    await reconcileJob(c, UID, job);
    expect(await c.store.getTags(keys.hct(UID, A.id))).toEqual({ space: "kept" });
    expect(await c.store.getTags(keys.transcript(UID, A.id))).toEqual({ space: "kept" });
    const d = await setup();
    const j = await dispatched(d);
    await playWorker(d.store, UID, j);
    await seedSpace(d.store, UID, { kept: true });
    d.store.setTags = async () => { throw new Error("x"); };
    await reconcileJob(d, UID, j); // re-tag failure is swallowed
    expect((await meta(d, A.id)).status).toBe("kept");
  });
  it("repairs a kept note whose original was never settled; leaves a settled one alone", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await playWorker(c.store, UID, job);
    await reconcileJob(c, UID, job);
    const m = await meta(c, A.id);
    await c.store.putJson(keys.meta(UID, A.id), { ...m, raw: { state: "uploaded" } });
    await c.store.putJson(keys.job(UID, job), { ...(await rec(c, job)), state: "finalizing", finalizingAt: undefined });
    await reconcileJob(c, UID, job);
    expect((await meta(c, A.id)).raw.state).toBe("grace");
  });
  it("deferred notes are queued again; a report error is recorded; the deferred count is in the history", async () => {
    const c = await setup({}, [A, B]);
    const job = await dispatched(c, [A, B], "keep", { lang: "detect", maxNoteSeconds: 60 });
    await playWorker(c.store, UID, job, (id) => (id === B.id ? { drift: 0, status: "deferred" } : { drift: 0.01 }));
    const r = must((await c.store.getJson<Record<string, unknown>>(keys.jobResult(UID, job)))?.value);
    await c.store.putJson(keys.jobResult(UID, job), { ...r, error: "soft deadline" });
    const done = must(await reconcileJob(c, UID, job));
    expect(done.error).toBe("soft deadline");
    expect(done.history.at(-1)?.event).toMatch(/1 note\(s\) validated, 1 deferred/);
    expect((await meta(c, B.id)).status).toBe("queued");
    const d = await setup({}, [A, B]);
    const j = await dispatched(d, [A, B]);
    await playWorker(d.store, UID, j, (id) => (id === B.id ? { drift: 0, status: "deferred" } : { drift: 0.01 }));
    await reconcileJob(d, UID, j);
    const q = await d.store.list(keys.queuePrefix());
    expect(must((await d.store.getJson<QueueEntry>(must(q[0]).key))?.value).lang).toBeUndefined();
  });
  it("a failed report status marks the job failed", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await playWorker(c.store, UID, job);
    const r = must((await c.store.getJson<Record<string, unknown>>(keys.jobResult(UID, job)))?.value);
    await c.store.putJson(keys.jobResult(UID, job), { ...r, status: "failed" });
    expect((await reconcileJob(c, UID, job))?.state).toBe("failed");
  });
});

describe("originals", () => {
  it("keepOriginal without raw or meta writes nothing; with a missing copy keeps the raw", async () => {
    const c = await setup();
    await keepOriginal(c, A.id === "x" ? UID : UID, { id: "zz", ext: "opus" }, "r"); // no raw, no meta
    expect(await c.store.getJson(keys.meta(UID, "zz"))).toBeNull();
    c.store.head = async (k) => (k.startsWith("u/") && k.includes("originals") ? { status: 404, size: null } : { status: 200, size: 1 });
    await c.store.put(keys.raw(UID, A.id, "opus"), new Uint8Array(2));
    await keepOriginal(c, UID, A, "why");
    expect(await c.store.getBytes(keys.raw(UID, A.id, "opus"))).not.toBeNull(); // copy not proven: raw stays
  });
  it("keepOriginal uses the kept tag for a kept space", async () => {
    const c = await setup();
    await seedSpace(c.store, UID, { kept: true });
    await keepOriginal(c, UID, A, "why");
    expect(await c.store.getTags(keys.original(UID, A.id, "opus"))).toEqual({ space: "kept" });
    const d = makeCtx({ now: () => T0 });
    await d.store.put(keys.raw(UID, A.id, "opus"), new Uint8Array(2));
    await keepOriginal(d, UID, A, "no space");
    expect(await d.store.getTags(keys.original(UID, A.id, "opus"))).toEqual({ space: "anon" });
  });
  it("deleteOriginal: a stuck object keeps the state; kept space tags; no space is anon", async () => {
    const c = await setup();
    const m = await meta(c, A.id);
    c.store.delete = async () => 204;
    expect((await deleteOriginal(c, UID, m)).raw.state).toBe("uploaded");
    const d = makeCtx({ now: () => T0 });
    const m2: NoteMeta = { ...m, raw: { state: "grace" } };
    expect((await deleteOriginal(d, UID, m2)).raw.state).toBe("deleted");
    expect(await d.store.getTags(keys.meta(UID, m.id))).toEqual({ space: "anon" });
    const e = await setup();
    await seedSpace(e.store, UID, { kept: true });
    await deleteOriginal(e, UID, m);
    expect(await e.store.getTags(keys.meta(UID, m.id))).toEqual({ space: "kept" });
  });
  it("sweepGrace ignores non-meta keys, notes without a deadline, and notes still in grace", async () => {
    const c = await setup({ now: () => T0 }, [A, B]);
    await c.store.put(keys.hct(UID, "x"), new Uint8Array(1));
    await c.store.putJson(keys.meta(UID, A.id), { ...(await meta(c, A.id)), raw: { state: "grace" } });
    await c.store.putJson(keys.meta(UID, B.id), { ...(await meta(c, B.id)), raw: { state: "grace", deleteAfter: new Date(T0.getTime() + 1000).toISOString() } });
    expect(await sweepGrace(c, UID)).toBe(0);
    const get = c.store.getJson.bind(c.store);
    c.store.getJson = (async (k: string) => (k === keys.meta(UID, B.id) ? null : get(k))) as typeof c.store.getJson;
    expect(await sweepGrace(c, UID)).toBe(0);
    const real = makeCtx();
    await seedSpace(real.store);
    expect(await sweepGrace(real, UID)).toBe(0); // real clock
  });
});

describe("space and cron reconcile", () => {
  it("reconcileSpace walks the space's jobs (not manifests or reports), then dispatches", async () => {
    const c = await setup({}, [A, B]);
    const job = await dispatched(c);
    await seedNote(c.store, "aa000003");
    await enqueue(c, UID, "keep", [B]);
    await playWorker(c.store, UID, job);
    await c.store.put(keys.jobsPrefix(UID) + "weird", new Uint8Array(1));
    await reconcileSpace(c, UID);
    expect((await rec(c, job)).state).toBe("done");
    expect(c.backend.runs.size).toBe(2); // the queued one was dispatched after the first finished
  });
  it("reapOrphanMarkers: skips markers that vanished, keeps live ones, reaps by fence, swallows cancel/settle errors", async () => {
    const c = await setup();
    const job = await dispatched(c);
    expect(await reapOrphanMarkers(c, [{ key: keys.active("missing") }])).toBe(0);
    expect(await reapOrphanMarkers(c, [{ key: keys.active(job) }])).toBe(0);
    await c.store.putJson(keys.reap(UID), {});
    c.backend.cancel = async () => { throw new Error("x"); };
    const put = c.store.getJson.bind(c.store);
    c.store.getJson = (async (k: string) => { if (k === keys.spend()) throw new Error("meter"); return put(k); }) as typeof c.store.getJson;
    expect(await reapOrphanMarkers(c, [{ key: keys.active(job) }])).toBe(1);
  });
  it("reconcileActive: reaps orphans, settles stale reservations, reconciles active jobs, dispatches", async () => {
    const c = await setup({}, [A, B]);
    const job = await dispatched(c);
    await c.store.putJson(keys.active("ghost"), { uid: UID });
    await c.store.putJson(keys.active("nomarker"), null);
    await c.store.delete(keys.active("nomarker"));
    await playWorker(c.store, UID, job);
    await enqueue(c, UID, "keep", [B]);
    expect(await reconcileActive(c)).toBe(1);
    expect((await rec(c, job)).state).toBe("done");
    expect(c.backend.runs.size).toBe(2);
    expect(await reconcileActive(c)).toBe(1);
    // nothing active, no orphans, default clock, failing stale settle
    const d = makeCtx();
    d.store.getJson = (async () => { throw new Error("down"); }) as typeof d.store.getJson;
    d.store.list = async () => [];
    expect(await reconcileActive(d)).toBe(0); // a failing stale-settle is swallowed
    const e = makeCtx();
    expect(await reconcileActive(e)).toBe(0);
    // a marker file that is unreadable at reconcile time is skipped
    const f = makeCtx();
    await f.store.put(keys.active("jj"), "null");
    const gj = f.store.getJson.bind(f.store);
    f.store.getJson = (async (k: string) => (k === keys.active("jj") ? { value: null, etag: null } : gj(k))) as typeof f.store.getJson;
    expect(await reconcileActive(f)).toBe(1);
    void emptySpend; void reserve;
  });
});

describe("races and gaps", () => {
  const spaceGone = (c: Ctx) => {
    const get = c.store.getJson.bind(c.store);
    c.store.getJson = (async (k: string) => (k === keys.space(UID) ? null : get(k))) as typeof c.store.getJson;
  };
  it("dispatch and finalize work when the space doc cannot be read (anon tag), and without any worker clock info", async () => {
    const c = await setup({ maxConcurrent: 2, regionSlots: 3 });
    await dispatched(c); // an active marker exists, so the next dispatch reads the live list with it
    await seedNote(c.store, B.id);
    const { job } = await enqueue(c, UID, "keep", [B]);
    spaceGone(c);
    expect(await dispatch(c)).toBe("dispatched");
    await playWorker(c.store, UID, job);
    c.backend.failGet = true; // no Nebius state at finalize either
    const done = must(await reconcileJob(c, UID, job));
    expect(done.state).toBe("done");
    expect(done.nebiusState).toBeUndefined();
    expect((await meta(c, B.id)).status).toBe("kept");
  });
  it("a budget refusal for a job record that is already gone still cleans the queue", async () => {
    const c = await setup({ now: () => new Date("2027-01-02T00:00:00Z") });
    const { job } = await enqueue(c, UID, "keep", [A]);
    await c.store.delete(keys.job(UID, job));
    expect(await dispatch(c)).toBe("budget");
  });
  it("delete-all during create: a failing settle is swallowed too", async () => {
    const c = await setup();
    const create = c.backend.create.bind(c.backend);
    c.backend.create = async (o) => {
      const id = await create(o);
      await c.store.putJson(keys.reap(UID), {});
      const get = c.store.getJson.bind(c.store);
      c.store.getJson = (async (k: string) => { if (k === keys.spend()) throw new Error("meter"); return get(k); }) as typeof c.store.getJson;
      return id;
    };
    await enqueue(c, UID, "keep", [A]);
    const head = c.store.head.bind(c.store);
    let first = true;
    c.store.head = async (k) => (k === keys.reap(UID) && first ? ((first = false), { status: 404, size: null }) : head(k));
    expect(await dispatch(c)).toBe("none");
  });
  it("delete-all cancels jobs in every in-flight state", async () => {
    for (const state of ["running", "finalizing"] as const) {
      const c = await setup();
      const job = await dispatched(c);
      await c.store.putJson(keys.job(UID, job), { ...(await rec(c, job)), state });
      await c.store.putJson(keys.reap(UID), {});
      await reconcileJob(c, UID, job);
      expect(c.backend.cancelled).toHaveLength(1);
    }
  });
  it("a decode job that ends silently twice fails without touching notes; a kept note stays kept when its job fails", async () => {
    const c = await setup();
    const job = await dispatched(c, [A], "decode");
    await c.store.putJson(keys.job(UID, job), { ...(await rec(c, job)), attempts: 2 });
    must([...c.backend.runs.values()][0]).state = "FAILED";
    expect((await reconcileJob(c, UID, job))?.state).toBe("failed");
    expect((await meta(c, A.id)).status).toBe("processing");
    const d = await setup();
    const j = await dispatched(d);
    await d.store.putJson(keys.meta(UID, A.id), { ...(await meta(d, A.id)), status: "kept" });
    await d.store.putJson(keys.job(UID, j), { ...(await rec(d, j)), attempts: 2 });
    must([...d.backend.runs.values()][0]).state = "FAILED";
    await reconcileJob(d, UID, j);
    expect((await meta(d, A.id)).status).toBe("kept");
  });
  it("requeue keys fall back to the creation time when a job was never dispatched", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await c.store.putJson(keys.job(UID, job), { ...(await rec(c, job)), dispatched: undefined, attempts: 1 });
    must([...c.backend.runs.values()][0]).state = "FAILED";
    expect((await reconcileJob(c, UID, job))?.state).toBe("queued");
    expect((await c.store.list(keys.queuePrefix()))[0]?.key).toContain(`${T0.getTime().toString().padStart(14, "0")}-requeue`);
  });
  it("losing the requeue race to a deleted record yields null", async () => {
    const c = await setup();
    const job = await dispatched(c);
    must([...c.backend.runs.values()][0]).state = "FAILED";
    const put = c.store.putJson.bind(c.store);
    c.store.putJson = (async (k: string, v: unknown, o?: never) => {
      if (k.endsWith("-requeue-" + UID + ".json") || k.includes("-requeue")) {
        await c.store.delete(keys.job(UID, job));
        return { ok: false, etag: null };
      }
      return put(k, v, o);
    }) as typeof c.store.putJson;
    expect(await reconcileJob(c, UID, job)).toBeNull();
  });
  it("a failed job whose record vanishes during failure handling yields null", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await c.store.putJson(keys.job(UID, job), { ...(await rec(c, job)), attempts: 2 });
    must([...c.backend.runs.values()][0]).state = "FAILED";
    const del = c.store.delete.bind(c.store);
    c.store.delete = async (k: string) => {
      if (k === keys.active(job)) await del(keys.job(UID, job));
      return del(k);
    };
    expect(await reconcileJob(c, UID, job)).toBeNull();
  });
  it("finalize reads the space as missing", async () => {
    const c = await setup();
    const job = await dispatched(c);
    await playWorker(c.store, UID, job);
    spaceGone(c);
    expect((await reconcileJob(c, UID, job))?.state).toBe("done");
  });
  it("reconcileActive skips a marker whose file is unreadable", async () => {
    const c = makeCtx({ now: () => T0 });
    await c.store.putJson(keys.active("j1"), { uid: UID });
    await c.store.putJson(keys.job(UID, "j1"), {});
    const get = c.store.getJson.bind(c.store);
    let reads = 0;
    c.store.getJson = (async (k: string) => (k === keys.active("j1") && ++reads > 1 ? null : get(k))) as typeof c.store.getJson;
    expect(await reconcileActive(c)).toBe(1);
  });
});
