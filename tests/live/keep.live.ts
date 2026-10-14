/**
 * H1 / R11: one real note through the PRODUCT path, with the app's own code — no mocks of the judged capability.
 *
 *   HEARTH_LIVE_RUNS=3 npm run test:live -- tests/live/keep.live.ts
 *
 * Each run: a fresh space, the note uploaded to raw/ with a presigned PUT (as the browser does), queued, ONE real
 * Nebius Serverless Job dispatched by `dispatch()`, reconciled until kept (time-to-kept = upload complete -> kept,
 * queue wait printed separately), then "Delete original now": raw/ and originals/ must both HEAD 404. The memory
 * step runs (sample space, so Token Factory may see the FLEURS text) and memory.json's ETag must change with its
 * tag still on. Everything measured is written to evidence/keep-<stamp>.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { keys } from "@/lib/keys";
import { rememberNote } from "@/lib/memory";
import { loadConfig, loadTokenFactoryConfig } from "@/lib/nebius/config";
import { deleteOriginal, dispatch, enqueue, reconcileJob, type JobRecord, type NoteMeta, type PipelineCtx } from "@/lib/pipeline";
import { nebiusBackend } from "@/lib/server";
import { newId, newSpace } from "@/lib/space";
import { S3Store } from "@/lib/store";

const CLIP = process.env.HEARTH_LIVE_CLIP ?? "bench/fleurs/clip60.opus";
const RUNS = Number(process.env.HEARTH_LIVE_RUNS ?? 1);

it(`keeps ${RUNS} note(s) end to end on Nebius and proves the original gone`, async () => {
  const loaded = loadConfig();
  expect(loaded.configured, "Nebius env must be loaded").toBe(true);
  if (!loaded.configured) return;
  const config = loaded.config;
  const store = new S3Store(config);
  const ctx: PipelineCtx = {
    store,
    backend: nebiusBackend(config),
    image: config.workerImage,
    prebuilt: config.workerPrebuilt,
    preset: "4vcpu-16gb",
    maxConcurrent: 1,
    regionSlots: 2,
    publicUrl: process.env.HEARTH_PUBLIC_URL ?? "https://hearth.invalid",
    secret: process.env.HEARTH_SPACE_SECRET ?? "live-test",
    bucketWeights: process.env.HEARTH_BUCKET_WEIGHTS !== "false",
    trimmedCodec: process.env.HEARTH_TRIMMED_CODEC !== "false",
  };
  const audio = await store.getBytes(CLIP);
  expect(audio, `${CLIP} must exist in the bucket`).not.toBeNull();
  const ext = CLIP.split(".").pop() ?? "opus";
  const runs = [];
  for (let r = 0; r < RUNS; r += 1) {
    const uid = newId(16);
    const space = newSpace("Asia/Kolkata");
    space.consent = { at: new Date().toISOString(), textVersion: "live-test", deleteOriginals: true };
    await store.putJson(keys.space(uid), space, { tagging: "space=anon" });
    const id = newId(6);
    const meta: NoteMeta = {
      version: 1, id, name: path.basename(CLIP), ext, size: audio?.length ?? 0, label: "FLEURS", anchor: new Date().toISOString().slice(0, 10),
      anchorSource: "upload", uploaded: new Date().toISOString(), status: "uploading", raw: { state: "uploaded" },
    };
    await store.putJson(keys.meta(uid, id), meta, { tagging: "space=anon" });
    const put = await fetch(store.presignPut(keys.raw(uid, id, ext), 600, "space=anon"), {
      method: "PUT", headers: { "x-amz-tagging": "space=anon" }, body: new Uint8Array(audio as Uint8Array),
    });
    expect(put.status).toBe(200);
    const tUploaded = Date.now();
    meta.status = "queued";
    await store.putJson(keys.meta(uid, id), meta, { tagging: "space=anon" });
    const { job } = await enqueue(ctx, uid, "keep", [{ id, ext }]);
    let rec: JobRecord | null = null;
    let tDispatched: number | null = null;
    for (;;) {
      const d = await dispatch(ctx);
      if (d === "dispatched" && tDispatched === null) tDispatched = Date.now();
      rec = await reconcileJob(ctx, uid, job);
      if (rec && (rec.state === "done" || rec.state === "failed")) break;
      if (Date.now() - tUploaded > 35 * 60_000) throw new Error(`job ${job} still ${rec?.state} after 35 min`);
      await new Promise((res) => setTimeout(res, 10_000));
    }
    const tKept = Date.now();
    const kept = (await store.getJson<NoteMeta>(keys.meta(uid, id)))?.value;
    expect(rec?.state).toBe("done");
    expect(kept?.status).toBe("kept");
    expect((await store.head(keys.hct(uid, id))).status).toBe(200);
    const before = await store.getJson(keys.memory(uid));
    const memoryState = await rememberNote(store, loadTokenFactoryConfig(), uid, id, { isSample: true });
    const after = await store.getJson(keys.memory(uid));
    const memTags = await store.getTags(keys.memory(uid));
    const deleted = await deleteOriginal(ctx, uid, kept as NoteMeta);
    expect(deleted.raw.rawHead).toBe(404);
    expect(deleted.raw.originalHead).toBe(404);
    expect(after?.etag).toBeTruthy();
    expect(after?.etag).not.toBe(before?.etag ?? null);
    expect(memTags).toEqual({ space: "anon" });
    runs.push({
      run: r + 1, job, nebiusId: rec?.nebiusId, clip: CLIP, audioS: kept?.kept?.audioS, bytesHct: kept?.kept?.bytesHct,
      sha256: kept?.kept?.sha256, driftNote: kept?.kept?.driftNote, driftPass: kept?.kept?.driftPass, timings: kept?.kept?.timings,
      timeToKeptS: Math.round((tKept - tUploaded) / 1000), queueWaitS: tDispatched ? Math.round((tDispatched - tUploaded) / 1000) : null,
      jobHistory: rec?.history, memory: memoryState, memoryEtagChanged: after?.etag !== (before?.etag ?? null), memoryTags: memTags,
      raw: deleted.raw,
    });
    // The evidence space is removed afterwards; only the evidence file remains.
    for (const prefix of keys.spacePrefixes(uid)) for (const o of await store.list(prefix)) await store.delete(o.key);
  }
  const ttk = runs.map((r) => r.timeToKeptS).sort((a, b) => a - b);
  const median = ttk[Math.floor((ttk.length - 1) / 2)];
  const out = { at: new Date().toISOString(), clip: CLIP, image: config.workerImage, runs, medianTimeToKeptS: median, h1KillOver8min: (median ?? 0) > 480 };
  const file = path.resolve(__dirname, `../../evidence/keep-${out.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(readFileSync(file, "utf8").slice(0, 2000));
});
