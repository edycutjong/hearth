/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures: indexes are known to exist */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
const jarSet = vi.fn((name: string, value: string, _o: unknown) => void jar.set(name, value));
let hdrs = new Headers();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined), set: jarSet }),
  headers: async () => hdrs,
}));

const jobs = vi.hoisted(() => ({
  createJob: vi.fn(async () => "aijob-1"),
  getJob: vi.fn(),
  listJobs: vi.fn(),
  cancelJob: vi.fn(async () => undefined),
}));
vi.mock("@/lib/nebius/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/nebius/jobs")>()), ...jobs }));

import * as server from "@/lib/server";
import { COOKIE, signSpace, newSpace } from "@/lib/space";
import { MemoryStore } from "@/lib/store";
import { keys } from "@/lib/keys";
import { UID } from "./helpers";

const cfg = { workerImage: "img", workerPrebuilt: true, maxConcurrentJobs: 3 } as never;

beforeEach(() => {
  jar.clear();
  jarSet.mockClear();
  hdrs = new Headers();
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe("nebiusBackend", () => {
  it("maps create/get/cancel/liveJobs onto the Jobs API", async () => {
    const b = server.nebiusBackend(cfg);
    expect(await b.create({ name: "n", image: "i", env: { A: "1" }, files: [], preset: "p", timeoutSeconds: 5 } as never)).toBe("aijob-1");
    expect(jobs.createJob).toHaveBeenCalledWith(cfg, expect.objectContaining({ name: "n", containerCommand: "bash", args: "/opt/hearth/run.sh", timeoutSeconds: 5 }));
    jobs.getJob.mockResolvedValue({ status: { state: "ERROR", stateDetails: { code: "Q", message: "m" }, startedAt: "s", finishedAt: "f" } });
    expect(await b.get("x")).toEqual({ state: "ERROR", code: "Q", message: "m", startedAt: "s", finishedAt: "f" });
    jobs.getJob.mockResolvedValue({ status: { state: "RUNNING" } });
    expect(await b.get("x")).toMatchObject({ state: "RUNNING", code: undefined });
    await b.cancel("x");
    expect(jobs.cancelJob).toHaveBeenCalledWith(cfg, "x");
    jobs.listJobs.mockResolvedValue([
      { metadata: { id: "a", name: "A" }, status: { state: "RUNNING" } },
      { metadata: { id: "b", name: "B" }, status: { state: "COMPLETED" } },
    ]);
    expect(await b.liveJobs()).toEqual([{ id: "a", name: "A" }]);
  });
});

describe("env helpers", () => {
  it("secret: explicit, production guard, dev fallback", () => {
    vi.stubEnv("HEARTH_SPACE_SECRET", "  s3 ");
    expect(server.secret()).toBe("s3");
    vi.stubEnv("HEARTH_SPACE_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    expect(() => server.secret()).toThrow(/not set/);
    vi.stubEnv("VERCEL", "");
    expect(server.secret()).toBe("development-only-secret");
    vi.stubEnv("NODE_ENV", "test");
    expect(server.secret()).toBe("development-only-secret");
  });
  it("publicUrl precedence", () => {
    vi.stubEnv("HEARTH_PUBLIC_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("VERCEL_URL", "");
    expect(server.publicUrl()).toBe("http://localhost:3000");
    vi.stubEnv("VERCEL_URL", "prev.vercel.app");
    expect(server.publicUrl()).toBe("https://prev.vercel.app");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "prod.dev");
    expect(server.publicUrl()).toBe("https://prod.dev");
    vi.stubEnv("HEARTH_PUBLIC_URL", "https://x.test//");
    expect(server.publicUrl()).toBe("https://x.test");
  });
  it("flags and judge code", () => {
    expect(server.flags.zdrOn()).toBe(false);
    expect(server.flags.zdrConfirmed()).toBe(false);
    vi.stubEnv("TF_ZDR_ON", "true");
    vi.stubEnv("TF_ZDR_CONFIRMED", "true");
    expect(server.flags.zdrOn()).toBe(true);
    expect(server.flags.zdrConfirmed()).toBe(true);
    vi.stubEnv("HEARTH_JUDGE_CODE", "");
    expect(server.isJudgeCode("abc")).toBe(false);
    vi.stubEnv("HEARTH_JUDGE_CODE", " abc ");
    expect(server.isJudgeCode(" abc")).toBe(true);
    expect(server.isJudgeCode("nope")).toBe(false);
    expect(server.isJudgeCode(5)).toBe(false);
  });
});

describe("ready", () => {
  const ENV = ["NEBIUS_PROJECT_ID", "NEBIUS_SA_ID", "NEBIUS_PUBLIC_KEY_ID", "NEBIUS_PRIVATE_KEY", "NEBIUS_PRIVATE_KEY_PATH", "NEBIUS_SUBNET_ID", "NEBIUS_S3_ACCESS_KEY_ID", "NEBIUS_S3_SECRET_ACCESS_KEY"];
  it("reports missing config", () => {
    for (const k of ENV) vi.stubEnv(k, "");
    const r = server.ready();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing.length).toBeGreaterThan(0);
  });
  it("builds a context when configured", async () => {
    vi.resetModules();
    vi.doMock("@/lib/nebius/config", async (orig) => ({
      ...(await orig<typeof import("@/lib/nebius/config")>()),
      loadConfig: () => ({ configured: true, config: { workerImage: "img", workerPrebuilt: true, maxConcurrentJobs: 3, bucket: "b", region: "r", endpoint: "https://e" } }),
    }));
    const s = await import("@/lib/server");
    vi.stubEnv("HEARTH_PRESET", "");
    vi.stubEnv("HEARTH_BUCKET_WEIGHTS", "false");
    vi.stubEnv("HEARTH_TRIMMED_CODEC", "");
    const r = s.ready();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ctx).toMatchObject({ image: "img", prebuilt: true, preset: "4vcpu-16gb", maxConcurrent: 3, regionSlots: 2, bucketWeights: false, trimmedCodec: true });
    }
    vi.stubEnv("HEARTH_PRESET", "8vcpu");
    const r2 = s.ready();
    if (r2.ok) expect(r2.ctx.preset).toBe("8vcpu");
    vi.doUnmock("@/lib/nebius/config");
    vi.resetModules();
  });
});

describe("space cookie + loading", () => {
  it("currentUid reads the signed cookie", async () => {
    expect(await server.currentUid()).toBeNull();
    jar.set(COOKIE, signSpace(server.secret(), UID));
    expect(await server.currentUid()).toBe(UID);
    jar.set(COOKIE, `${UID}.forged`);
    expect(await server.currentUid()).toBeNull();
  });
  it("loadSpace: existing, missing without create, new with create", async () => {
    const store = new MemoryStore();
    expect(await server.loadSpace(store)).toBeNull();
    jar.set(COOKIE, signSpace(server.secret(), UID));
    expect(await server.loadSpace(store)).toBeNull(); // cookie, but the space is gone
    const doc = newSpace("Asia/Kolkata");
    await store.putJson(keys.space(UID), doc);
    expect(await server.loadSpace(store)).toEqual({ uid: UID, doc });
    await store.delete(keys.space(UID));
    const made = await server.loadSpace(store, { create: true, timeZone: "Asia/Kolkata" });
    expect(made?.uid).not.toBe(UID);
    expect(made?.doc.timeZone).toBe("Asia/Kolkata");
    expect((await store.getTags(keys.space(made!.uid)))).toEqual({ space: "anon" });
    expect(jarSet).toHaveBeenCalledOnce();
    jar.clear();
    const dflt = await server.loadSpace(store, { create: true });
    expect(dflt?.doc.timeZone).toBe("UTC");
  });
  it("setSpaceCookie: secure only on https, lifetime by kept", async () => {
    vi.stubEnv("HEARTH_PUBLIC_URL", "https://h.test");
    const set = vi.fn();
    server.setSpaceCookie({ set } as never, UID, true);
    expect(set.mock.calls[0]![2]).toMatchObject({ httpOnly: true, secure: true, maxAge: 400 * 86_400 });
    vi.stubEnv("HEARTH_PUBLIC_URL", "http://h.test");
    server.setSpaceCookie({ set } as never, UID, false);
    expect(set.mock.calls[1]![2]).toMatchObject({ secure: false, maxAge: 7 * 86_400 });
  });
  it("saveSpace tags by kept", async () => {
    const store = new MemoryStore();
    const doc = newSpace("UTC");
    await server.saveSpace(store, UID, doc);
    expect(await store.getTags(keys.space(UID))).toEqual({ space: "anon" });
    await server.saveSpace(store, UID, { ...doc, kept: true });
    expect(await store.getTags(keys.space(UID))).toEqual({ space: "kept" });
  });
});

describe("request helpers", () => {
  it("clientKey hashes ip: forwarded, real-ip, unknown", async () => {
    hdrs = new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" });
    const a = await server.clientKey();
    expect(a).toMatch(/^[a-f0-9]{16}$/);
    hdrs = new Headers({ "x-forwarded-for": "1.1.1.1" });
    expect(await server.clientKey()).toBe(a);
    hdrs = new Headers({ "x-real-ip": "3.3.3.3" });
    const b = await server.clientKey();
    hdrs = new Headers();
    const c = await server.clientKey();
    expect(new Set([a, b, c]).size).toBe(3);
  });
  it("readBody tolerates junk", async () => {
    const mk = (body: string) => new Request("http://x", { method: "POST", body });
    expect(await server.readBody(mk('{"a":1}'))).toEqual({ a: 1 });
    for (const bad of ["null", "[1]", "5", "{oops"]) expect(await server.readBody(mk(bad))).toEqual({});
  });
  it("json and notConfigured", async () => {
    const r = server.json({ ok: 1 }, 201, { "x-a": "b" });
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-a")).toBe("b");
    expect(await r.json()).toEqual({ ok: 1 });
    expect(server.json(1).status).toBe(200);
    const n = server.notConfigured(["A"]);
    expect(n.status).toBe(503);
    expect(await n.json()).toMatchObject({ missing: ["A"] });
  });
  it("tfConfig is the Token Factory loader", async () => {
    expect(server.tfConfig.name).toBe("loadTokenFactoryConfig");
  });
});
