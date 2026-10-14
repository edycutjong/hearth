/**
 * Server-side wiring for the API routes: the configured store, the Nebius Jobs backend, the visitor's space,
 * and the privacy flags. Nothing here is imported by client components.
 */

import { cookies, headers } from "next/headers";
import { keys } from "./keys";
import { getJob, listJobs, createJob, TERMINAL_STATES } from "./nebius/jobs";
import { loadConfig, loadTokenFactoryConfig, type NebiusConfig } from "./nebius/config";
import type { JobsBackend, PipelineCtx } from "./pipeline";
import { COOKIE, ANON_DAYS, newId, newSpace, signSpace, verifySpace, type SpaceDoc } from "./space";
import { S3Store, type Store } from "./store";

export function nebiusBackend(config: NebiusConfig): JobsBackend {
  return {
    async create(opts) {
      return createJob(config, {
        name: opts.name,
        image: opts.image,
        env: opts.env,
        files: opts.files,
        preset: opts.preset,
        timeoutSeconds: opts.timeoutSeconds,
        containerCommand: "bash",
        args: "/opt/hearth/run.sh",
      });
    },
    async get(id) {
      const job = await getJob(config, id);
      return {
        state: job.status.state,
        code: job.status.stateDetails?.code,
        message: job.status.stateDetails?.message,
        startedAt: job.status.startedAt,
        finishedAt: job.status.finishedAt,
      };
    },
    async liveJobs() {
      return (await listJobs(config))
        .filter((j) => !TERMINAL_STATES.has(j.status.state))
        .map((j) => ({ id: j.metadata.id, name: j.metadata.name }));
    },
  };
}

export function secret(): string {
  const s = process.env.HEARTH_SPACE_SECRET?.trim();
  if (s) return s;
  if (process.env.NODE_ENV === "production" && process.env.VERCEL) throw new Error("HEARTH_SPACE_SECRET is not set");
  return "development-only-secret";
}

export function publicUrl(): string {
  const explicit = process.env.HEARTH_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (prod) return `https://${prod}`;
  const preview = process.env.VERCEL_URL?.trim();
  if (preview) return `https://${preview}`;
  return "http://localhost:3000";
}

export type Ready = { ok: true; config: NebiusConfig; store: Store; ctx: PipelineCtx } | { ok: false; missing: string[] };

export function ready(): Ready {
  const loaded = loadConfig();
  if (!loaded.configured) return { ok: false, missing: loaded.missing };
  const config = loaded.config;
  const store = new S3Store(config);
  return {
    ok: true,
    config,
    store,
    ctx: {
      store,
      backend: nebiusBackend(config),
      image: config.workerImage,
      prebuilt: config.workerPrebuilt,
      preset: process.env.HEARTH_PRESET?.trim() || "4vcpu-16gb",
      maxConcurrent: config.maxConcurrentJobs,
      regionSlots: 2,
      publicUrl: publicUrl(),
      secret: secret(),
      bucketWeights: process.env.HEARTH_BUCKET_WEIGHTS !== "false",
      trimmedCodec: process.env.HEARTH_TRIMMED_CODEC !== "false",
    },
  };
}

export const tfConfig = loadTokenFactoryConfig;

export const flags = {
  zdrOn: () => process.env.TF_ZDR_ON === "true",
  zdrConfirmed: () => process.env.TF_ZDR_CONFIRMED === "true",
};

export function isJudgeCode(code: unknown): boolean {
  const want = process.env.HEARTH_JUDGE_CODE?.trim();
  return typeof code === "string" && !!want && code.trim() === want;
}

/** The visitor's uid from the signed cookie (null if none or forged). */
export async function currentUid(): Promise<string | null> {
  const jar = await cookies();
  return verifySpace(secret(), jar.get(COOKIE)?.value);
}

/** Load the visitor's space, creating it (and its cookie) when asked to. */
export async function loadSpace(store: Store, opts: { create?: boolean; timeZone?: string } = {}): Promise<{ uid: string; doc: SpaceDoc } | null> {
  const jar = await cookies();
  let uid = verifySpace(secret(), jar.get(COOKIE)?.value);
  if (uid) {
    const got = await store.getJson<SpaceDoc>(keys.space(uid));
    if (got) return { uid, doc: got.value };
  }
  if (!opts.create) return null;
  uid = uid ?? newId(16);
  const doc = newSpace(opts.timeZone ?? "UTC");
  await store.putJson(keys.space(uid), doc, { tagging: "space=anon" });
  setSpaceCookie(jar, uid, false);
  return { uid, doc };
}

export function setSpaceCookie(jar: Awaited<ReturnType<typeof cookies>>, uid: string, kept: boolean): void {
  jar.set(COOKIE, signSpace(secret(), uid), {
    httpOnly: true,
    sameSite: "lax",
    secure: publicUrl().startsWith("https://"),
    path: "/",
    maxAge: kept ? 400 * 86_400 : ANON_DAYS * 86_400,
  });
}

export async function saveSpace(store: Store, uid: string, doc: SpaceDoc): Promise<void> {
  await store.putJson(keys.space(uid), doc, { tagging: doc.kept ? "space=kept" : "space=anon" });
}

/** A coarse per-IP key for rate limits: hashed with the day, never stored raw. */
export async function clientKey(): Promise<string> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(`${new Date().toISOString().slice(0, 10)}:${ip}:${secret()}`).digest("hex").slice(0, 16);
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

export function notConfigured(missing: string[]): Response {
  return json({ error: "This deployment has no Nebius credentials, so it can show the sample but cannot keep new notes.", missing }, 503);
}
