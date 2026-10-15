import { describe, expect, it } from "vitest";
import { keys } from "@/lib/keys";
import { rememberNote, type MemoryDoc, type TranscriptDoc } from "@/lib/memory";
import type { TokenFactoryConfig } from "@/lib/nebius/config";
import { dispatch, enqueue, reconcileJob, type JobRecord, type NoteMeta } from "@/lib/pipeline";
import type { Extraction } from "@/lib/tf";
import { UID, makeCtx, must, playWorker, seedNote, seedSpace } from "./helpers";

const OTHER = "fedcba9876543210fedcba9876543210";
const T: TranscriptDoc = { version: 1, lang: "hi-IN", lang_detected: "hi-IN", duration_s: 9, segments: [{ i: 0, t0: 0, t1: 9, text: "रविवार से पहले पाँच हज़ार भेज देना" }] };
const TF = { baseUrl: "https://tf.test/v1", apiKey: "k", model: "m" } as TokenFactoryConfig;
const EXTRACTION: Extraction = { items: [], glosses: [{ segment: 0, en: "Send five thousand before Sunday." }] };

/** A Token Factory that answers only when released, so the test can act while the call is in flight. */
function slowTf() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const impl = (async () => {
    await gate;
    return new Response(JSON.stringify({ id: "chatcmpl-slow", choices: [{ message: { content: JSON.stringify(EXTRACTION) } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, release: () => release() };
}

async function keptNote(ctx: ReturnType<typeof makeCtx>, uid = UID) {
  const meta: NoteMeta = {
    version: 1, id: "aa000001", name: "n.opus", ext: "opus", size: 1, label: "Maa", anchor: "2026-10-12", anchorSource: "filename",
    uploaded: "2026-10-12T00:00:00Z", status: "kept", raw: { state: "grace" }, memory: "pending",
  };
  await ctx.store.putJson(keys.meta(uid, "aa000001"), meta, { tagging: "space=anon" });
  await ctx.store.putJson(keys.transcript(uid, "aa000001"), T, { tagging: "space=anon" });
}

describe("the deletion fence", () => {
  it("reaps an active marker whose job record was deleted, so the slot is not held forever", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store, UID);
    await seedSpace(ctx.store, OTHER);
    await seedNote(ctx.store, "bb000001", OTHER);
    await ctx.store.putJson(keys.active("2026101500deadbe"), { uid: UID, nebiusId: "aijob-orphan", dispatched: "2026-10-15T00:00:00Z" });
    await enqueue(ctx, OTHER, "keep", [{ id: "bb000001", ext: "opus" }]);
    expect(await dispatch(ctx)).toBe("dispatched");
    expect((await ctx.store.list(keys.activePrefix())).map((o) => o.key)).not.toContain(keys.active("2026101500deadbe"));
    expect(ctx.backend.cancelled).toContain("aijob-orphan");
  });

  it("drops a queue entry whose space is gone or being deleted, without creating a Job", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store, UID);
    await seedNote(ctx.store, "aa000001");
    await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await ctx.store.putJson(keys.reap(UID), { at: new Date().toISOString() });
    expect(await dispatch(ctx)).toBe("none");
    expect(ctx.backend.runs.size).toBe(0);
    expect(await ctx.store.list(keys.queuePrefix())).toHaveLength(0);
  });

  it("stops a reconcile of a space being deleted: the Job is cancelled and its marker removed", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await dispatch(ctx);
    await ctx.store.putJson(keys.reap(UID), { at: new Date().toISOString() });
    expect(await reconcileJob(ctx, UID, job)).toBeNull();
    expect(ctx.backend.cancelled).toHaveLength(1);
    expect(await ctx.store.list(keys.activePrefix())).toHaveLength(0);
  });

  it("a memory pass that finishes after the wipe writes nothing back", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store, UID, { tfOptIn: { at: "x", textVersion: "v1" } });
    await keptNote(ctx);
    const tf = slowTf();
    const pass = rememberNote(ctx.store, TF, UID, "aa000001", { env: {}, fetchImpl: tf.impl });
    await new Promise((r) => setTimeout(r, 20));
    await ctx.store.putJson(keys.reap(UID), { at: new Date().toISOString() });
    for (const prefix of keys.spacePrefixes(UID)) for (const o of await ctx.store.list(prefix)) await ctx.store.delete(o.key);
    tf.release();
    await pass;
    for (const prefix of keys.spacePrefixes(UID)) expect(await ctx.store.list(prefix)).toEqual([]);
  });

  it("a memory pass tags its writes with the space's tag at write time (Keep my space during the call)", async () => {
    const ctx = makeCtx();
    const space = await seedSpace(ctx.store, UID, { tfOptIn: { at: "x", textVersion: "v1" } });
    await keptNote(ctx);
    const tf = slowTf();
    const pass = rememberNote(ctx.store, TF, UID, "aa000001", { env: {}, fetchImpl: tf.impl });
    await new Promise((r) => setTimeout(r, 20));
    await ctx.store.putJson(keys.space(UID), { ...space, kept: true }, { tagging: "space=kept" });
    tf.release();
    expect(await pass).toBe("done");
    expect(await ctx.store.getTags(keys.meta(UID, "aa000001"))).toEqual({ space: "kept" });
    expect(await ctx.store.getTags(keys.memory(UID))).toEqual({ space: "kept" });
    expect(must((await ctx.store.getJson<MemoryDoc>(keys.memory(UID)))?.value).calls).toHaveLength(1);
  });
});

describe("finalize and requeue under failures", () => {
  it("repairs a kept note whose original was never moved (a finalize that died half way)", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await dispatch(ctx);
    await playWorker(ctx.store, UID, job, () => ({ drift: 0.12 })); // fails the drift gate: the original must be kept
    const copy = ctx.store.copy.bind(ctx.store);
    ctx.store.copy = async () => {
      throw new Error("COPY failed: 503");
    };
    await expect(reconcileJob(ctx, UID, job)).rejects.toThrow(/COPY/);
    const half = must((await ctx.store.getJson<NoteMeta>(keys.meta(UID, "aa000001")))?.value);
    expect([half.status, half.raw.state]).toEqual(["kept", "uploaded"]);
    ctx.store.copy = copy;
    const rec = must((await ctx.store.getJson<JobRecord>(keys.job(UID, job)))?.value);
    await ctx.store.putJson(keys.job(UID, job), { ...rec, finalizingAt: "2000-01-01T00:00:00Z" }); // the claim went stale
    await reconcileJob(ctx, UID, job);
    const fixed = must((await ctx.store.getJson<NoteMeta>(keys.meta(UID, "aa000001")))?.value);
    expect(fixed.raw.state).toBe("kept_original");
    expect((await ctx.store.head(keys.original(UID, "aa000001", "opus"))).status).toBe(200);
    expect((await ctx.store.head(keys.raw(UID, "aa000001", "opus"))).status).toBe(404);
  });

  it("requeues an attempt once, however many requests reconcile it at the same time", async () => {
    const ctx = makeCtx();
    ctx.backend.foreign = 1;
    ctx.backend.slots = 1;
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const { job } = await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    ctx.regionSlots = 3;
    await dispatch(ctx);
    await Promise.all([reconcileJob(ctx, UID, job), reconcileJob(ctx, UID, job), reconcileJob(ctx, UID, job)]);
    expect(await ctx.store.list(keys.queuePrefix())).toHaveLength(1);
  });

  it("leaves no job record behind when its queue entry cannot be written", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    const putJson = ctx.store.putJson.bind(ctx.store);
    ctx.store.putJson = async (key, value, opts) => {
      if (key.startsWith("sys/queue/")) throw new Error("PUT failed: 503");
      return putJson(key, value, opts);
    };
    await expect(enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }])).rejects.toThrow(/503/);
    expect(await ctx.store.list(keys.jobsPrefix(UID))).toHaveLength(0);
  });

  it("takes over a stale dispatch lock", async () => {
    const ctx = makeCtx();
    await seedSpace(ctx.store);
    await seedNote(ctx.store, "aa000001");
    await enqueue(ctx, UID, "keep", [{ id: "aa000001", ext: "opus" }]);
    await ctx.store.putJson("sys/claims/_dispatch.json", { at: "2000-01-01T00:00:00Z" });
    expect(await dispatch(ctx)).toBe("dispatched");
  });
});
