/**
 * The keep pipeline on the app side: queue -> one Nebius Job -> validate what it wrote -> verified deletion.
 *
 * Queue. At most one Hearth Job runs at a time; the tenant quota (2 instances per region) is shared with the
 * builder's other entries, and past it Nebius creates the job and ends it at once with QuotaExceeded. So a
 * dispatch first counts the region's live jobs, and a QuotaExceeded (or a 429 on create) is a REQUEUE with
 * backoff (30 s doubling to 4 min) — never a failure, never a spent retry. A claim object written with
 * If-None-Match makes each queue entry dispatch once even when two requests race.
 *
 * Validation. The app trusts a note's result only when its job id and note id match the request and the
 * sha256 of the stored .hct (read back by the app) equals the one the worker reported.
 *
 * Deletion. Raw audio is deleted by the APP, never the Job: after the drift gate passes and a 24 h grace (so
 * the user can A/B their own note), or at once on "Delete original now". "Deleted" means HEAD of the raw key
 * AND of the originals key both return 404. A note that fails the drift gate, fails to process, or whose user
 * chose to keep originals is copied to u/<uid>/originals/ (tag replaced, so it still expires with an anonymous
 * space) and only then removed from raw/.
 */

import { createHmac } from "node:crypto";
import { JOB_TIMEOUT_HOURS, release, reserve, settle } from "./caps";
import { keys, spaceTag } from "./keys";
import type { SpaceDoc } from "./space";
import type { Store } from "./store";
import { REQUIREMENTS_SOURCE, RUN_SOURCE, WORKER_SOURCE } from "./worker-source";

/** Fixed prior, set before any data (complexity.md §2): note drift <= 5 %, and <= 30 % for segments of >= 8 words. */
export const DRIFT_GATE_NOTE = 0.05;
export const DRIFT_GATE_SEGMENT = 0.3;
export const DRIFT_SEGMENT_MIN_WORDS = 8;
export const GRACE_HOURS = 24;
/** Presigned URLs outlive the provisioning wait (<= 30 min) plus the Job timeout. */
export const URL_TTL_SECONDS = 3 * 3600;
export const MAX_ATTEMPTS = 2;

export interface JobsBackend {
  create(opts: {
    name: string;
    image: string;
    env: Record<string, string>;
    files: Array<{ containerPath: string; content: string }>;
    preset: string;
    timeoutSeconds: number;
  }): Promise<string>;
  get(id: string): Promise<{ state: string; code?: string; message?: string; startedAt?: string; finishedAt?: string }>;
  /** Live (non-terminal) jobs in the project, from every app that shares it. */
  liveJobs(): Promise<Array<{ id: string; name: string }>>;
}

/** Product Jobs are named hearth-<job id>; the D0 and bench harness Jobs (hearth-d0-…) always count. */
const PRODUCT_JOB = /^hearth-(\d{8}[0-9a-f]{1,8})$/;

/**
 * Does a live job hold a region slot? A Hearth Job whose report the app has already validated (its active marker is
 * gone) has finished its work: Nebius still lists it as RUNNING while the container exits, and counting it would hold
 * the next note back for a whole backoff. Every other job — the harness, other apps on the tenant — counts.
 */
export function holdsSlot(job: { name: string }, activeJobs: ReadonlySet<string>): boolean {
  const m = PRODUCT_JOB.exec(job.name);
  return !(m && !activeJobs.has(m[1] as string));
}

/** Model files copied into the in-region bucket by the D0 harness; product Jobs read them instead of Hugging Face. */
export const MODEL_KEYS = {
  asr: "models/nemotron-3.5-asr-streaming-0.6b.nemo",
  codec: "models/nemo-nano-codec-22khz-1.78kbps-12.5fps.nemo",
} as const;

export interface PipelineCtx {
  store: Store;
  backend: JobsBackend;
  image: string;
  prebuilt: boolean;
  preset: string;
  maxConcurrent: number;
  /** Region capacity: compute.instance.count. */
  regionSlots: number;
  publicUrl: string;
  secret: string;
  /** Read the model files from the bucket (fast, in-region) instead of Hugging Face. */
  bucketWeights?: boolean;
  /** Load NanoCodec without its training-only discriminators and speaker encoder (validated bit-exact by D0). */
  trimmedCodec?: boolean;
  now?: () => Date;
}

export interface NoteRef {
  id: string;
  ext: string;
}

export interface QueueEntry {
  version: 1;
  uid: string;
  job: string;
  kind: "keep" | "decode";
  notes: NoteRef[];
  created: string;
  attempts: number;
  /** Requeues after QuotaExceeded / 429; never counted as attempts. */
  backoffs: number;
  nextTry: string;
  maxNoteSeconds?: number;
  lang?: string;
}

export type JobState = "queued" | "dispatched" | "running" | "finalizing" | "done" | "failed";

export interface JobRecord {
  version: 1;
  job: string;
  kind: "keep" | "decode";
  notes: NoteRef[];
  state: JobState;
  created: string;
  queueKey?: string;
  nebiusId?: string;
  nebiusState?: string;
  dispatched?: string;
  started?: string;
  finished?: string;
  attempts: number;
  backoffs: number;
  preset: string;
  error?: string;
  /** Where the time went, in seconds, from the Job's own report (see jobTimings). */
  timings?: JobTimings;
  history: Array<{ at: string; event: string }>;
}

export interface JobTimings {
  /** queued -> Nebius job created */
  queueS: number | null;
  /** created -> container running: Nebius provisioning, image pull, container start */
  startupS: number | null;
  /** dependency install in the container */
  installS: number | null;
  /** both models ready (the weights stream in during the install) */
  modelsS: number | null;
  /** the notes themselves: ASR, encode, decode, ASR again, uploads */
  workS: number | null;
  /** the weight prefetch's own duration, overlapped with the install */
  prefetchS: number | null;
}

export type RawState = "uploaded" | "grace" | "deleted" | "kept_original";

export interface NoteMeta {
  version: 1;
  id: string;
  name: string;
  ext: string;
  size: number;
  label: string;
  anchor: string;
  anchorSource: "filename" | "chat" | "upload";
  uploaded: string;
  status: "uploading" | "uploaded" | "queued" | "processing" | "kept" | "failed";
  job?: string;
  nebiusId?: string;
  kept?: {
    at: string;
    bytesHct: number;
    sha256: string;
    frames: number;
    audioS: number;
    inputBytes: number;
    driftNote: number;
    maxDriftLongSegment: number | null;
    driftPass: boolean;
    langDetected: string | null;
    timings: Record<string, number>;
  };
  raw: {
    state: RawState;
    deleteAfter?: string;
    reason?: string;
    rawHead?: number;
    originalHead?: number;
    checkedAt?: string;
  };
  memory?: "pending" | "done" | "paused" | "skipped" | "failed";
  memoryError?: string;
  error?: string;
}

const iso = (d: Date) => d.toISOString();
const clock = (ctx: PipelineCtx) => (ctx.now ? ctx.now() : new Date());

export function tickToken(secret: string, uid: string, job: string): string {
  return createHmac("sha256", secret).update(`tick:${uid}:${job}`).digest("hex").slice(0, 32);
}

export function backoffSeconds(backoffs: number): number {
  return Math.min(240, 30 * 2 ** Math.max(0, backoffs));
}

export function driftPasses(driftNote: number, segments: Array<{ words: number; drift: number | null }>): boolean {
  if (!(driftNote <= DRIFT_GATE_NOTE)) return false;
  return segments.every((s) => s.words < DRIFT_SEGMENT_MIN_WORDS || s.drift === null || s.drift <= DRIFT_GATE_SEGMENT);
}

// ---------------------------------------------------------------- enqueue

export async function enqueue(
  ctx: PipelineCtx,
  uid: string,
  kind: "keep" | "decode",
  notes: NoteRef[],
  opts: { maxNoteSeconds?: number; lang?: string } = {},
): Promise<{ job: string; queueKey: string }> {
  const now = clock(ctx);
  const stamp = `${now.getTime().toString().padStart(14, "0")}-${Math.random().toString(16).slice(2, 8)}`;
  const job = `${now.toISOString().slice(0, 10).replace(/-/g, "")}${Math.random().toString(16).slice(2, 10)}`;
  const queueKey = keys.queueEntry(stamp, uid);
  const entry: QueueEntry = {
    version: 1, uid, job, kind, notes, created: iso(now), attempts: 0, backoffs: 0, nextTry: iso(now), ...opts,
  };
  const record: JobRecord = {
    version: 1, job, kind, notes, state: "queued", created: iso(now), queueKey, attempts: 0, backoffs: 0,
    preset: ctx.preset, history: [{ at: iso(now), event: "queued" }],
  };
  const space = await ctx.store.getJson<SpaceDoc>(keys.space(uid));
  const tag = spaceTag(space?.value.kept ?? false);
  await ctx.store.putJson(keys.job(uid, job), record, { tagging: tag });
  await ctx.store.putJson(queueKey, entry);
  return { job, queueKey };
}

export async function queuePosition(ctx: PipelineCtx, queueKey: string): Promise<number | null> {
  const all = await ctx.store.list(keys.queuePrefix());
  const i = all.findIndex((o) => o.key === queueKey);
  return i < 0 ? null : i + 1;
}

// ---------------------------------------------------------------- dispatch

async function updateRecord(ctx: PipelineCtx, uid: string, job: string, patch: (r: JobRecord) => void): Promise<JobRecord | null> {
  const cur = await ctx.store.getJson<JobRecord>(keys.job(uid, job));
  if (!cur) return null;
  const rec = cur.value;
  patch(rec);
  const space = await ctx.store.getJson<SpaceDoc>(keys.space(uid));
  await ctx.store.putJson(keys.job(uid, job), rec, { tagging: spaceTag(space?.value.kept ?? false) });
  return rec;
}

function isThrottle(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|quota|ResourceExhausted|Too Many Requests/i.test(msg);
}

/** Dispatch at most one queued entry. Returns what happened, for the UI and the tests. */
export async function dispatch(ctx: PipelineCtx): Promise<"none" | "busy" | "dispatched" | "backoff" | "budget" | "failed"> {
  const { store } = ctx;
  const now = clock(ctx);
  const active = await store.list(keys.activePrefix());
  if (active.length >= ctx.maxConcurrent) return "busy";
  const queue = await store.list(keys.queuePrefix());
  for (const obj of queue) {
    const got = await store.getJson<QueueEntry>(obj.key);
    if (!got) continue;
    const entry = got.value;
    if (new Date(entry.nextTry) > now) continue;
    const name = obj.key.split("/").pop() ?? obj.key;
    const claim = await store.putJson(keys.claim(name), { at: iso(now) }, { condition: { ifNoneMatch: "*" } });
    if (!claim.ok) {
      const c = await store.getJson<{ at: string }>(keys.claim(name));
      if (c && now.getTime() - new Date(c.value.at).getTime() > 5 * 60_000) await store.delete(keys.claim(name));
      continue;
    }
    try {
      let live = 0;
      try {
        const activeJobs = new Set(active.map((o) => (o.key.split("/").pop() ?? "").replace(/\.json$/, "")));
        live = (await ctx.backend.liveJobs()).filter((j) => holdsSlot(j, activeJobs)).length;
      } catch {
        live = 0;
      }
      if (live >= ctx.regionSlots) {
        entry.backoffs += 1;
        entry.nextTry = iso(new Date(now.getTime() + backoffSeconds(entry.backoffs) * 1000));
        await store.putJson(obj.key, entry);
        await updateRecord(ctx, entry.uid, entry.job, (r) => {
          r.backoffs = entry.backoffs;
          r.history.push({ at: iso(now), event: `region full (${live} live jobs): waiting ${backoffSeconds(entry.backoffs)} s` });
        });
        return "backoff";
      }
      const budget = await reserve(store, entry.job, ctx.preset, now);
      if (!budget.ok) {
        await updateRecord(ctx, entry.uid, entry.job, (r) => {
          r.state = "failed";
          r.error = `processing budget: ${budget.reason}`;
          r.history.push({ at: iso(now), event: `refused: ${budget.reason}` });
        });
        await store.delete(obj.key);
        await markNotes(ctx, entry.uid, entry.notes, (m) => {
          m.status = "uploaded";
          m.error = "Today's processing budget is used; the note is safe and can be kept later.";
        });
        return "budget";
      }
      let nebiusId: string;
      try {
        nebiusId = await createJob(ctx, entry);
      } catch (err) {
        await release(store, entry.job);
        if (isThrottle(err)) {
          entry.backoffs += 1;
          entry.nextTry = iso(new Date(now.getTime() + backoffSeconds(entry.backoffs) * 1000));
          await store.putJson(obj.key, entry);
          return "backoff";
        }
        entry.attempts += 1;
        if (entry.attempts >= MAX_ATTEMPTS) {
          await store.delete(obj.key);
          await failJob(ctx, entry.uid, entry.job, `could not create the Nebius job: ${String(err).slice(0, 200)}`);
          return "failed";
        }
        entry.nextTry = iso(new Date(now.getTime() + 30_000));
        await store.putJson(obj.key, entry);
        return "backoff";
      }
      await store.putJson(keys.active(entry.job), { uid: entry.uid, nebiusId, dispatched: iso(now) });
      await updateRecord(ctx, entry.uid, entry.job, (r) => {
        r.state = "dispatched";
        r.nebiusId = nebiusId;
        r.dispatched = iso(now);
        r.attempts = entry.attempts + 1;
        r.history.push({ at: iso(now), event: `Nebius job ${nebiusId} created` });
      });
      await markNotes(ctx, entry.uid, entry.notes, (m) => {
        m.status = "processing";
        m.job = entry.job;
        m.nebiusId = nebiusId;
      });
      await store.delete(obj.key);
      return "dispatched";
    } finally {
      await store.delete(keys.claim(name));
    }
  }
  return "none";
}

async function createJob(ctx: PipelineCtx, entry: QueueEntry): Promise<string> {
  const { store } = ctx;
  const space = await store.getJson<SpaceDoc>(keys.space(entry.uid));
  const tag = spaceTag(space?.value.kept ?? false);
  const tagged = (key: string) => ({ url: store.presignPut(key, URL_TTL_SECONDS, tag), headers: { "x-amz-tagging": tag } });
  const tick = `${ctx.publicUrl.replace(/\/+$/, "")}/api/tick?u=${entry.uid}&j=${entry.job}&t=${tickToken(ctx.secret, entry.uid, entry.job)}`;
  const manifest = {
    version: 1,
    mode: entry.kind,
    job: entry.job,
    lang: entry.lang ?? "hi-IN",
    max_note_s: entry.maxNoteSeconds ?? 300,
    result_put: tagged(keys.jobResult(entry.uid, entry.job)),
    status_put: tagged(keys.jobStatus(entry.uid, entry.job)),
    tick_url: tick,
    trimmed_codec: Boolean(ctx.trimmedCodec),
    weights: ctx.bucketWeights
      ? { asr: store.presignGet(MODEL_KEYS.asr, URL_TTL_SECONDS), codec: store.presignGet(MODEL_KEYS.codec, URL_TTL_SECONDS) }
      : null,
    notes: entry.notes.map((n) =>
      entry.kind === "keep"
        ? {
            id: n.id,
            ext: n.ext,
            get: store.presignGet(keys.raw(entry.uid, n.id, n.ext), URL_TTL_SECONDS),
            put: {
              hct: tagged(keys.hct(entry.uid, n.id)),
              transcript: tagged(keys.transcript(entry.uid, n.id)),
              wav: tagged(keys.cacheWav(entry.uid, n.id)),
              result: tagged(keys.noteResult(entry.uid, entry.job, n.id)),
            },
          }
        : { id: n.id, hct_get: store.presignGet(keys.hct(entry.uid, n.id), URL_TTL_SECONDS), put: { wav: tagged(keys.cacheWav(entry.uid, n.id)) } },
    ),
  };
  await store.putJson(keys.jobManifest(entry.uid, entry.job), manifest, { tagging: tag });
  const env: Record<string, string> = {
    MODE: entry.kind,
    MANIFEST_URL: store.presignGet(keys.jobManifest(entry.uid, entry.job), URL_TTL_SECONDS),
    HEARTH_JOB_NAME: `hearth-${entry.job}`,
  };
  if (ctx.prebuilt) env.HEARTH_PREBUILT = "1";
  return ctx.backend.create({
    name: `hearth-${entry.job}`,
    image: ctx.image,
    env,
    files: [
      { containerPath: "/opt/hearth/worker.py", content: WORKER_SOURCE },
      { containerPath: "/opt/hearth/run.sh", content: RUN_SOURCE },
      { containerPath: "/opt/hearth/requirements.txt", content: REQUIREMENTS_SOURCE },
    ],
    preset: ctx.preset,
    timeoutSeconds: JOB_TIMEOUT_HOURS * 3600,
  });
}

async function markNotes(ctx: PipelineCtx, uid: string, notes: NoteRef[], patch: (m: NoteMeta) => void): Promise<void> {
  const space = await ctx.store.getJson<SpaceDoc>(keys.space(uid));
  const tag = spaceTag(space?.value.kept ?? false);
  for (const n of notes) {
    const cur = await ctx.store.getJson<NoteMeta>(keys.meta(uid, n.id));
    if (!cur) continue;
    patch(cur.value);
    await ctx.store.putJson(keys.meta(uid, n.id), cur.value, { tagging: tag });
  }
}

async function failJob(ctx: PipelineCtx, uid: string, job: string, error: string): Promise<void> {
  const now = clock(ctx);
  const rec = await updateRecord(ctx, uid, job, (r) => {
    r.state = "failed";
    r.error = error;
    r.finished = iso(now);
    r.history.push({ at: iso(now), event: `failed: ${error}` });
  });
  if (rec?.kind === "keep") {
    for (const n of rec.notes) await keepOriginal(ctx, uid, n, "processing failed: the original is kept");
    await markNotes(ctx, uid, rec.notes, (m) => {
      if (m.status !== "kept") {
        m.status = "failed";
        m.error = error;
      }
    });
  }
  await ctx.store.delete(keys.active(job));
}

// ---------------------------------------------------------------- reconcile + finalize

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "ERROR"]);

interface WorkerNoteResult {
  id: string;
  status: "processed" | "failed" | "decoded";
  job?: string;
  error?: string;
  bytes_hct?: number;
  sha256_hct?: string;
  frames?: number;
  audio_s?: number;
  input_bytes?: number;
  drift_note?: number;
  max_drift_long_segment?: number | null;
  segments?: Array<{ words: number; drift: number | null }>;
  lang_detected?: string | null;
  timings?: Record<string, number>;
}

interface WorkerReport {
  status: "done" | "failed";
  job?: string;
  error?: string;
  notes?: WorkerNoteResult[];
  load?: Record<string, number>;
  context?: Record<string, unknown>;
  /** epoch seconds when the worker wrote its final report */
  finished?: number;
}

/** The time of one Job, split where it is spent; null where the report lacks a mark. Clocks: the app's and the VM's. */
export function jobTimings(rec: Pick<JobRecord, "created" | "dispatched">, report: Pick<WorkerReport, "context" | "load" | "finished">): JobTimings {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const epoch = (iso?: string) => (iso ? new Date(iso).getTime() / 1000 : null);
  const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((a - b) * 10) / 10);
  const created = epoch(rec.created);
  const dispatched = epoch(rec.dispatched);
  const t0 = num(report.context?.t0);
  const tInstall = num(report.context?.t_install);
  const start = num(report.context?.worker_start);
  const load = num(report.load?.total_s);
  const finished = num(report.finished);
  return {
    queueS: diff(dispatched, created),
    startupS: diff(t0, dispatched),
    installS: diff(tInstall, t0),
    modelsS: load === null ? null : Math.round(load * 10) / 10,
    workS: finished === null || start === null || load === null ? null : diff(finished, start + load),
    prefetchS: num(report.load?.prefetch_s),
  };
}

/** Bring one job forward. Safe to call any number of times, from any request. */
export async function reconcileJob(ctx: PipelineCtx, uid: string, job: string): Promise<JobRecord | null> {
  const { store } = ctx;
  const now = clock(ctx);
  const cur = await store.getJson<JobRecord>(keys.job(uid, job));
  if (!cur) return null;
  const rec = cur.value;
  if (rec.state !== "dispatched" && rec.state !== "running") return rec;
  const report = (await store.getJson<WorkerReport>(keys.jobResult(uid, job)))?.value ?? null;
  let nebius: Awaited<ReturnType<JobsBackend["get"]>> | null = null;
  if (rec.nebiusId) {
    try {
      nebius = await ctx.backend.get(rec.nebiusId);
    } catch {
      nebius = null;
    }
  }
  if (report && (report.status === "done" || report.status === "failed") && report.job === job) {
    return finalize(ctx, uid, rec, report, nebius);
  }
  if (nebius && TERMINAL.has(nebius.state)) {
    const quota = /quota/i.test(`${nebius.code ?? ""} ${nebius.message ?? ""}`);
    await settle(store, job, quota ? 0 : hoursBetween(rec.dispatched, nebius.finishedAt ?? iso(now)));
    await store.delete(keys.active(job));
    if (quota || rec.attempts < MAX_ATTEMPTS) {
      // Requeue: a QuotaExceeded is not an attempt; a silent job gets its second try.
      const backoffs = rec.backoffs + (quota ? 1 : 0);
      const entry: QueueEntry = {
        version: 1, uid, job, kind: rec.kind, notes: rec.notes, created: rec.created,
        attempts: quota ? rec.attempts - 1 : rec.attempts, backoffs,
        nextTry: iso(new Date(now.getTime() + (quota ? backoffSeconds(backoffs) : 30) * 1000)),
      };
      const stamp = `${now.getTime().toString().padStart(14, "0")}-requeue`;
      await store.putJson(keys.queueEntry(stamp, uid), entry);
      return updateRecord(ctx, uid, job, (r) => {
        r.state = "queued";
        r.queueKey = keys.queueEntry(stamp, uid);
        r.backoffs = backoffs;
        r.history.push({
          at: iso(now),
          event: quota
            ? `Nebius job ${rec.nebiusId} hit the region quota (QuotaExceeded); requeued`
            : `Nebius job ${rec.nebiusId} ended ${nebius?.state} without a report; retrying (${rec.attempts + 1} of ${MAX_ATTEMPTS})`,
        });
      });
    }
    await failJob(ctx, uid, job, `Nebius job ${rec.nebiusId} ended ${nebius.state} without a report (tried ${rec.attempts} times)`);
    return (await store.getJson<JobRecord>(keys.job(uid, job)))?.value ?? null;
  }
  if (nebius && nebius.state !== rec.nebiusState) {
    return updateRecord(ctx, uid, job, (r) => {
      r.nebiusState = nebius?.state;
      if (nebius?.state === "RUNNING") {
        r.state = "running";
        r.started = nebius.startedAt ?? iso(now);
      }
      r.history.push({ at: iso(now), event: `Nebius job ${nebius?.state}` });
    });
  }
  return rec;
}

function hoursBetween(a: string | undefined, b: string): number {
  if (!a) return JOB_TIMEOUT_HOURS;
  return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

async function finalize(
  ctx: PipelineCtx,
  uid: string,
  rec: JobRecord,
  report: WorkerReport,
  nebius: Awaited<ReturnType<JobsBackend["get"]>> | null,
): Promise<JobRecord | null> {
  const { store } = ctx;
  const now = clock(ctx);
  const space = (await store.getJson<SpaceDoc>(keys.space(uid)))?.value;
  const tag = spaceTag(space?.kept ?? false);
  const deleteOriginals = space?.consent?.deleteOriginals ?? true;
  for (const n of rec.notes) {
    const res = report.notes?.find((r) => r.id === n.id);
    const meta = (await store.getJson<NoteMeta>(keys.meta(uid, n.id)))?.value;
    if (!meta) continue;
    if (rec.kind === "decode") continue;
    if (!res || res.status !== "processed" || res.job !== rec.job) {
      meta.status = "failed";
      meta.error = res?.error ?? report.error ?? "the job reported no result for this note";
      await store.putJson(keys.meta(uid, n.id), meta, { tagging: tag });
      await keepOriginal(ctx, uid, n, "processing failed: the original is kept");
      continue;
    }
    const hct = await store.getBytes(keys.hct(uid, n.id));
    const sha = hct ? await sha256Hex(hct) : null;
    if (!hct || sha !== res.sha256_hct || hct.length !== res.bytes_hct) {
      meta.status = "failed";
      meta.error = "the stored tokens do not match the job's report (sha256); the original is kept";
      await store.putJson(keys.meta(uid, n.id), meta, { tagging: tag });
      await keepOriginal(ctx, uid, n, "validation failed: the original is kept");
      continue;
    }
    const pass = driftPasses(res.drift_note ?? 1, res.segments ?? []);
    meta.status = "kept";
    meta.kept = {
      at: iso(now),
      bytesHct: hct.length,
      sha256: sha,
      frames: res.frames ?? 0,
      audioS: res.audio_s ?? 0,
      inputBytes: res.input_bytes ?? meta.size,
      driftNote: res.drift_note ?? 1,
      maxDriftLongSegment: res.max_drift_long_segment ?? null,
      driftPass: pass,
      langDetected: res.lang_detected ?? null,
      timings: res.timings ?? {},
    };
    meta.memory = "pending";
    if (pass && deleteOriginals) {
      meta.raw = { state: "grace", deleteAfter: iso(new Date(now.getTime() + GRACE_HOURS * 3_600_000)) };
      await store.putJson(keys.meta(uid, n.id), meta, { tagging: tag });
    } else {
      await store.putJson(keys.meta(uid, n.id), meta, { tagging: tag });
      await keepOriginal(
        ctx, uid, n,
        !pass ? `original kept: the codec round trip changed ${(100 * (res.drift_note ?? 1)).toFixed(1)} % of words` : "original kept: your choice",
      );
    }
  }
  const finished = nebius?.finishedAt ?? iso(now);
  await settle(store, rec.job, hoursBetween(rec.dispatched, finished));
  await store.delete(keys.active(rec.job));
  return updateRecord(ctx, uid, rec.job, (r) => {
    r.state = report.status === "done" ? "done" : "failed";
    r.finished = finished;
    r.timings = jobTimings(r, report);
    r.nebiusState = nebius?.state ?? r.nebiusState;
    if (report.error) r.error = report.error;
    r.history.push({ at: iso(now), event: `report ${report.status}; ${rec.notes.length} note(s) validated` });
  });
}

/** Copy raw -> originals (tag replaced), delete raw, prove the raw key is gone. */
export async function keepOriginal(ctx: PipelineCtx, uid: string, n: NoteRef, reason: string): Promise<void> {
  const { store } = ctx;
  const rawKey = keys.raw(uid, n.id, n.ext);
  const origKey = keys.original(uid, n.id, n.ext);
  const space = (await store.getJson<SpaceDoc>(keys.space(uid)))?.value;
  const tag = spaceTag(space?.kept ?? false);
  if ((await store.head(rawKey)).status === 200) {
    await store.copy(rawKey, origKey, tag);
    if ((await store.head(origKey)).status === 200) await store.delete(rawKey);
  }
  const meta = (await store.getJson<NoteMeta>(keys.meta(uid, n.id)))?.value;
  if (!meta) return;
  meta.raw = {
    state: "kept_original",
    reason,
    rawHead: (await store.head(rawKey)).status,
    originalHead: (await store.head(origKey)).status,
    checkedAt: iso(clock(ctx)),
  };
  await store.putJson(keys.meta(uid, n.id), meta, { tagging: tag });
}

/**
 * Delete a note's original: raw (after the grace, or now) and originals/ if the user kept it. Only when BOTH
 * HEADs return 404 does the note say "deleted".
 */
export async function deleteOriginal(ctx: PipelineCtx, uid: string, meta: NoteMeta): Promise<NoteMeta> {
  const { store } = ctx;
  const rawKey = keys.raw(uid, meta.id, meta.ext);
  const origKey = keys.original(uid, meta.id, meta.ext);
  await store.delete(rawKey);
  await store.delete(origKey);
  const rawHead = (await store.head(rawKey)).status;
  const originalHead = (await store.head(origKey)).status;
  meta.raw = {
    state: rawHead === 404 && originalHead === 404 ? "deleted" : meta.raw.state,
    rawHead,
    originalHead,
    checkedAt: iso(clock(ctx)),
  };
  const space = (await store.getJson<SpaceDoc>(keys.space(uid)))?.value;
  await store.putJson(keys.meta(uid, meta.id), meta, { tagging: spaceTag(space?.kept ?? false) });
  return meta;
}

/** Delete every original whose grace has passed. Lazy (on any visit to the space) and from the daily cron. */
export async function sweepGrace(ctx: PipelineCtx, uid: string): Promise<number> {
  const now = clock(ctx);
  let n = 0;
  for (const obj of await ctx.store.list(keys.notesPrefix(uid))) {
    if (!obj.key.endsWith(".meta.json")) continue;
    const meta = (await ctx.store.getJson<NoteMeta>(obj.key))?.value;
    if (meta?.raw.state === "grace" && meta.raw.deleteAfter && new Date(meta.raw.deleteAfter) <= now) {
      await deleteOriginal(ctx, uid, meta);
      n += 1;
    }
  }
  return n;
}

/** Reconcile every job of a space that is still in flight, then try to dispatch. */
export async function reconcileSpace(ctx: PipelineCtx, uid: string): Promise<void> {
  for (const obj of await ctx.store.list(keys.jobsPrefix(uid))) {
    const m = /\/jobs\/([^/]+)\.json$/.exec(obj.key);
    if (!m || m[1]?.includes(".")) continue;
    await reconcileJob(ctx, uid, m[1] as string);
  }
  await dispatch(ctx);
}

/** Reconcile every active job of every space (the cron and the tick use this). */
export async function reconcileActive(ctx: PipelineCtx): Promise<number> {
  const active = await ctx.store.list(keys.activePrefix());
  for (const obj of active) {
    const job = obj.key.split("/").pop()?.replace(/\.json$/, "") ?? "";
    const marker = (await ctx.store.getJson<{ uid: string }>(obj.key))?.value;
    if (marker) await reconcileJob(ctx, marker.uid, job);
  }
  await dispatch(ctx);
  return active.length;
}
