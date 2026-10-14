import { createHash } from "node:crypto";
import { keys } from "@/lib/keys";
import type { JobsBackend, NoteMeta, PipelineCtx } from "@/lib/pipeline";
import { newSpace, type SpaceDoc } from "@/lib/space";
import { MemoryStore } from "@/lib/store";

export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

interface FakeRun {
  id: string;
  name: string;
  env: Record<string, string>;
  files: Array<{ containerPath: string; content: string }>;
  state: string;
  code?: string;
  finishedAt?: string;
}

/** Nebius Jobs where it matters: create returns an id; past the quota the job is created and ends ERROR/QuotaExceeded. */
export class FakeBackend implements JobsBackend {
  runs = new Map<string, FakeRun>();
  throttle = 0;
  /** Live jobs belonging to other apps sharing the region. */
  foreign = 0;
  slots = 2;
  private n = 0;
  async create(opts: Parameters<JobsBackend["create"]>[0]): Promise<string> {
    if (this.throttle > 0) {
      this.throttle -= 1;
      throw new Error("POST /ai/v1/jobs failed: 429 Too Many Requests");
    }
    this.n += 1;
    const id = `aijob-fake${String(this.n).padStart(4, "0")}`;
    const over = (await this.liveCount()) >= this.slots;
    this.runs.set(id, { id, name: opts.name, env: opts.env, files: opts.files, state: over ? "ERROR" : "RUNNING", code: over ? "QuotaExceeded" : undefined });
    return id;
  }
  async get(id: string) {
    const r = this.runs.get(id);
    if (!r) throw new Error("404");
    return { state: r.state, code: r.code, finishedAt: r.finishedAt };
  }
  async liveCount() {
    return this.foreign + [...this.runs.values()].filter((r) => r.state === "RUNNING").length;
  }
  finish(id: string, state = "COMPLETED") {
    const r = this.runs.get(id);
    if (r) {
      r.state = state;
      r.finishedAt = new Date().toISOString();
    }
  }
}

export function makeCtx(over: Partial<PipelineCtx> = {}): PipelineCtx & { store: MemoryStore; backend: FakeBackend } {
  return {
    store: new MemoryStore(),
    backend: new FakeBackend(),
    image: "python:3.11",
    prebuilt: false,
    preset: "4vcpu-16gb",
    maxConcurrent: 1,
    regionSlots: 2,
    publicUrl: "https://hearth.test",
    secret: "test-secret",
    ...over,
  } as PipelineCtx & { store: MemoryStore; backend: FakeBackend };
}

export const UID = "0123456789abcdef0123456789abcdef";

export async function seedSpace(store: MemoryStore, uid = UID, patch: Partial<SpaceDoc> = {}): Promise<SpaceDoc> {
  const doc: SpaceDoc = {
    ...newSpace("Asia/Kolkata", new Date("2026-10-15T00:00:00Z")),
    consent: { at: "2026-10-15T00:00:00Z", textVersion: "v1", deleteOriginals: true },
    ...patch,
  };
  await store.putJson(keys.space(uid), doc, { tagging: "space=anon" });
  return doc;
}

export async function seedNote(store: MemoryStore, id: string, uid = UID, ext = "opus"): Promise<NoteMeta> {
  const meta: NoteMeta = {
    version: 1, id, name: `PTT-20261012-WA00${id.slice(-2)}.${ext}`, ext, size: 40_000, label: "Maa", anchor: "2026-10-12",
    anchorSource: "filename", uploaded: "2026-10-15T00:00:00Z", status: "uploaded", raw: { state: "uploaded" },
  };
  await store.put(keys.raw(uid, id, ext), new Uint8Array(40_000), { tagging: "space=anon" });
  await store.putJson(keys.meta(uid, id), meta, { tagging: "space=anon" });
  return meta;
}

/** Play the worker: read the manifest the app wrote and write what a real Job would. */
export async function playWorker(
  store: MemoryStore,
  uid: string,
  job: string,
  outcome: (noteId: string) => { drift: number; status?: "processed" | "failed"; tamper?: boolean } = () => ({ drift: 0.02 }),
): Promise<void> {
  const manifest = must((await store.getJson<{ notes: Array<{ id: string }> }>(keys.jobManifest(uid, job)))?.value, "manifest");
  const notes = [];
  for (const n of manifest.notes) {
    const o = outcome(n.id);
    const hct = new Uint8Array(1200).map((_, i) => (i * 7) % 251);
    await store.put(keys.hct(uid, n.id), hct, { tagging: "space=anon" });
    await store.putJson(keys.transcript(uid, n.id), {
      version: 1, lang: "hi-IN", lang_detected: "hi-IN", duration_s: 40,
      segments: [{ i: 0, t0: 0, t1: 8, text: "रविवार से पहले पाँच हज़ार भेज देना" }],
    });
    notes.push({
      id: n.id, status: o.status ?? "processed", job, bytes_hct: hct.length,
      sha256_hct: o.tamper ? "0".repeat(64) : createHash("sha256").update(hct).digest("hex"),
      frames: 500, audio_s: 40, input_bytes: 40_000, drift_note: o.drift, segments: [{ words: 7, drift: o.drift }],
      lang_detected: "hi-IN", timings: { asr_s: 3 },
    });
  }
  await store.putJson(keys.jobResult(uid, job), { status: "done", job, notes });
}
