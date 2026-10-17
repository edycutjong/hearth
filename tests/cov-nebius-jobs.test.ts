import { beforeEach, describe, expect, it } from "vitest";
import { resetTokenCache } from "@/lib/nebius/auth";
import type { NebiusConfig } from "@/lib/nebius/config";
import {
  INJECTED_FILE_MAX_BYTES,
  INJECTED_TOTAL_MAX_BASE64,
  NebiusApiError,
  TERMINAL_STATES,
  cancelJob,
  createJob,
  getJob,
  getJobByName,
  listJobs,
  logCall,
  recentCalls,
} from "@/lib/nebius/jobs";

const CFG = { region: "eu-west1", projectId: "proj-1", subnetId: "subnet-1" } as NebiusConfig;

import { must } from "./helpers";
const at = <T,>(a: T[], i: number): T => must(a[i]);

interface Call { url: string; init: RequestInit }

/** A fake Nebius: token exchange succeeds; every API call is answered by `handler`. */
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    if (url.includes("oauth2/token/exchange")) return new Response(JSON.stringify({ access_token: "TOK", expires_in: 43200 }), { status: 200 });
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, statusText: status === 404 ? "Not Found" : "X" });

// Real key needed for signJwt.
import { generateKeyPairSync } from "node:crypto";
CFG.privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
CFG.serviceAccountId = "sa";
CFG.authKeyId = "kid";

beforeEach(() => resetTokenCache());

describe("createJob", () => {
  it("posts an Operation-shaped request with defaults and returns resourceId", async () => {
    const { f, calls } = fakeFetch(() => json({ resourceId: "aijob-1" }));
    expect(await createJob(CFG, { name: "n", image: "img" }, f)).toBe("aijob-1");
    const c = at(calls, 0);
    expect(c.url).toBe("https://api.nebius.cloud/ai/v1/jobs");
    expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer TOK");
    const body = JSON.parse(c.init.body as string);
    expect(body.metadata).toEqual({ parentId: "proj-1", name: "n" });
    expect(body.spec).toMatchObject({
      image: "img", platform: "cpu-d3", preset: "4vcpu-16gb", subnetId: "subnet-1", timeout: "3600s",
      disk: { type: "NETWORK_SSD", sizeBytes: String(64 * 1024 ** 3) },
    });
    expect(body.spec.containerCommand).toBeUndefined();
    expect(body.spec.environmentVariables).toBeUndefined();
    expect(body.spec.injectedFiles).toBeUndefined();
  });

  it("maps every option onto the spec", async () => {
    const { f, calls } = fakeFetch(() => json({ resourceId: "j" }));
    await createJob(CFG, {
      name: "n", image: "i", target: { region: "r", projectId: "p2", subnetId: "s2" },
      containerCommand: "bash", args: "-c x", env: { A: "1", B: "2" }, platform: "gpu", preset: "p",
      timeoutSeconds: 7200, diskSizeBytes: 10,
      files: [
        { containerPath: "/a.txt", content: "hello" },
        { containerPath: "/b.bin", content: Buffer.from("raw").toString("base64"), encoding: "base64" },
      ],
    }, f);
    const body = JSON.parse(at(calls, 0).init.body as string);
    expect(body.metadata.parentId).toBe("p2");
    expect(body.spec).toMatchObject({
      subnetId: "s2", platform: "gpu", preset: "p", timeout: "7200s", containerCommand: "bash", args: "-c x",
      disk: { sizeBytes: "10" },
      environmentVariables: [{ name: "A", value: "1" }, { name: "B", value: "2" }],
      injectedFiles: [
        { containerPath: "/a.txt", content: Buffer.from("hello").toString("base64") },
        { containerPath: "/b.bin", content: Buffer.from("raw").toString("base64") },
      ],
    });
  });

  it("never goes under the 1 h API floor", async () => {
    const { f, calls } = fakeFetch(() => json({ resourceId: "j" }));
    await createJob(CFG, { name: "n", image: "i", timeoutSeconds: 60 }, f);
    expect(JSON.parse(at(calls, 0).init.body as string).spec.timeout).toBe("3600s");
  });

  it.each([
    ["empty", ""],
    ["over 64 KiB", "x".repeat(INJECTED_FILE_MAX_BYTES + 1)],
  ])("rejects a %s injected file before any API call", async (_n, content) => {
    const { f, calls } = fakeFetch(() => json({}));
    const err = await createJob(CFG, { name: "n", image: "i", files: [{ containerPath: "/x", content }] }, f).catch((e) => e);
    expect(err).toBeInstanceOf(NebiusApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("injected file /x");
    expect(calls).toHaveLength(0);
  });

  it("rejects when the base64 of all files passes the total ceiling", async () => {
    const { f, calls } = fakeFetch(() => json({}));
    const big = "x".repeat(40_000); // 40k bytes -> 53.3k base64 each; two files > 64 KiB total
    const err = await createJob(CFG, { name: "n", image: "i", files: [{ containerPath: "/1", content: big }, { containerPath: "/2", content: big }] }, f).catch((e) => e);
    expect(err.message).toContain(`more than ${INJECTED_TOTAL_MAX_BASE64}`);
    expect(calls).toHaveLength(0);
  });

  it("fails loudly when the operation carries no resourceId", async () => {
    const { f } = fakeFetch(() => json({ status: { code: 3 } }));
    const err = await createJob(CFG, { name: "n", image: "i" }, f).catch((e) => e);
    expect(err).toMatchObject({ name: "NebiusApiError", status: 502 });
    expect(err.body).toContain('"code":3');
  });

  it("surfaces an HTTP error with status and truncated body", async () => {
    const { f } = fakeFetch(() => new Response("q".repeat(2000), { status: 429, statusText: "Too Many" }));
    const err = await createJob(CFG, { name: "n", image: "i" }, f).catch((e) => e);
    expect(err.message).toBe("POST /ai/v1/jobs failed: 429 Too Many");
    expect(err.status).toBe(429);
    expect(err.body).toHaveLength(1000);
  });

  it("tolerates an unreadable error body", async () => {
    const bad = { ok: false, status: 500, statusText: "E", text: async () => { throw new Error("no"); } } as unknown as Response;
    const { f } = fakeFetch(() => bad);
    const err = await createJob(CFG, { name: "n", image: "i" }, f).catch((e) => e);
    expect(err.body).toBe("");
  });
});

describe("read endpoints", () => {
  it("getJob GETs the encoded id without a body", async () => {
    const job = { metadata: { id: "a/b" }, status: { state: "RUNNING" } };
    const { f, calls } = fakeFetch(() => json(job));
    expect(await getJob(CFG, "a/b", f)).toEqual(job);
    expect(at(calls, 0).url).toBe("https://api.nebius.cloud/ai/v1/jobs/a%2Fb");
    expect(at(calls, 0).init.method).toBe("GET");
    expect(at(calls, 0).init.body).toBeUndefined();
    expect((at(calls, 0).init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("getJobByName returns the job, null on 404, and rethrows other errors", async () => {
    const job = { metadata: { id: "j" }, status: { state: "RUNNING" } };
    let mode: "ok" | "404" | "500" | "net" = "ok";
    const { f, calls } = fakeFetch(() => {
      if (mode === "net") throw new TypeError("network down");
      return mode === "ok" ? json(job) : json({}, mode === "404" ? 404 : 500);
    });
    expect(await getJobByName(CFG, "p&1", "n m", f)).toEqual(job);
    expect(at(calls, 0).url).toBe("https://api.nebius.cloud/ai/v1/jobs/get-by-name?parentId=p%261&name=n%20m");
    mode = "404";
    expect(await getJobByName(CFG, "p", "n", f)).toBeNull();
    mode = "500";
    await expect(getJobByName(CFG, "p", "n", f)).rejects.toMatchObject({ status: 500 });
    mode = "net";
    await expect(getJobByName(CFG, "p", "n", f)).rejects.toThrow("network down");
  });

  it("listJobs uses the configured project by default and tolerates a missing items array", async () => {
    let body: unknown = { items: [{ metadata: { id: "x" } }] };
    const { f, calls } = fakeFetch(() => json(body));
    expect(await listJobs(CFG, undefined, f)).toHaveLength(1);
    expect(at(calls, 0).url).toContain("parentId=proj-1");
    body = {};
    expect(await listJobs(CFG, "other", f)).toEqual([]);
    expect(at(calls, 1).url).toContain("parentId=other");
  });

  it("cancelJob POSTs the id as JSON", async () => {
    const { f, calls } = fakeFetch(() => json({}));
    await cancelJob(CFG, "aijob-9", f);
    expect(at(calls, 0).url).toBe("https://api.nebius.cloud/ai/v1/jobs/cancel");
    expect(at(calls, 0).init.method).toBe("POST");
    expect(JSON.parse(at(calls, 0).init.body as string)).toEqual({ id: "aijob-9" });
    expect((at(calls, 0).init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});

describe("call log and states", () => {
  it("records every API call with its status", async () => {
    const { f } = fakeFetch(() => json({ items: [] }, 200));
    const before = recentCalls().length;
    await listJobs(CFG, "p", f);
    const last = must(recentCalls().at(-1));
    expect(recentCalls().length).toBe(before + 1);
    expect(last).toMatchObject({ method: "GET", path: "/ai/v1/jobs?parentId=p", status: 200 });
    expect(last.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps only the newest 200 entries", () => {
    for (let i = 0; i < 250; i++) logCall({ method: "GET", path: `/p${i}`, status: 200, durationMs: 0, at: "t" });
    expect(recentCalls()).toHaveLength(200);
    expect(must(recentCalls().at(-1)).path).toBe("/p249");
    expect(recentCalls()[0].path).toBe("/p50");
  });

  it("knows the terminal states", () => {
    for (const s of ["COMPLETED", "FAILED", "CANCELLED", "ERROR"]) expect(TERMINAL_STATES.has(s)).toBe(true);
    expect(TERMINAL_STATES.has("RUNNING")).toBe(false);
  });
});
