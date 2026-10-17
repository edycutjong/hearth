import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeToken, getAccessToken, NebiusAuthError, resetTokenCache, signJwt } from "@/lib/nebius/auth";
import {
  DEFAULT_BUCKET,
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_REGION,
  DEFAULT_WORKER_IMAGE,
  loadConfig,
  loadTokenFactoryConfig,
  MEMORY_MODEL,
  TOKEN_FACTORY_BASE_URL,
  type NebiusConfig,
} from "@/lib/nebius/config";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const E = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;
const ENV: Record<string, string> = {
  NEBIUS_SERVICE_ACCOUNT_ID: "sa-1",
  NEBIUS_AUTH_KEY_ID: "key-1",
  NEBIUS_AUTH_PRIVATE_KEY: "PEM",
  NEBIUS_PROJECT_ID: "project-1",
  NEBIUS_SUBNET_ID: "subnet-1",
  NEBIUS_S3_ACCESS_KEY_ID: "AK",
  NEBIUS_S3_SECRET_ACCESS_KEY: "SK",
};

describe("loadConfig", () => {
  it("lists every missing required variable and treats blanks as missing", () => {
    expect(loadConfig(E({}))).toMatchObject({ configured: false });
    const r = loadConfig({ ...ENV, NEBIUS_PROJECT_ID: "  ", NEBIUS_SUBNET_ID: undefined } as never);
    expect(r).toEqual({ configured: false, missing: ["NEBIUS_PROJECT_ID", "NEBIUS_SUBNET_ID"] });
  });

  it("applies defaults", () => {
    const r = loadConfig(E(ENV));
    if (!r.configured) throw new Error("expected configured");
    expect(r.config).toMatchObject({
      region: DEFAULT_REGION,
      bucket: DEFAULT_BUCKET,
      s3Endpoint: `https://storage.${DEFAULT_REGION}.nebius.cloud`,
      workerImage: DEFAULT_WORKER_IMAGE,
      workerPrebuilt: false,
      maxConcurrentJobs: DEFAULT_MAX_CONCURRENT_JOBS,
      serviceAccountId: "sa-1",
    });
  });

  it("honours overrides, unescapes \\n in the PEM and flags a baked image", () => {
    const r = loadConfig(E({
      ...ENV,
      NEBIUS_AUTH_PRIVATE_KEY: "a\\nb",
      NEBIUS_REGION: " eu-north1 ",
      HEARTH_BUCKET: "b2",
      NEBIUS_S3_ENDPOINT: "https://s3.example",
      HEARTH_WORKER_IMAGE: "ghcr.io/x/worker:1",
      HEARTH_MAX_CONCURRENT_JOBS: "2",
    }));
    if (!r.configured) throw new Error("expected configured");
    expect(r.config).toMatchObject({
      privateKeyPem: "a\nb",
      region: "eu-north1",
      bucket: "b2",
      s3Endpoint: "https://s3.example",
      workerImage: "ghcr.io/x/worker:1",
      workerPrebuilt: true,
      maxConcurrentJobs: 2,
    });
  });

  it.each(["0", "3", "1.5", "abc", ""])("falls back to 1 concurrent job for %j", (v) => {
    const r = loadConfig(E({ ...ENV, HEARTH_MAX_CONCURRENT_JOBS: v }));
    if (!r.configured) throw new Error("expected configured");
    expect(r.config.maxConcurrentJobs).toBe(1);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("NEBIUS_SERVICE_ACCOUNT_ID", "");
    expect(loadConfig().configured).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("loadTokenFactoryConfig", () => {
  it("is null without a key", () => {
    expect(loadTokenFactoryConfig(E({}))).toBeNull();
    expect(loadTokenFactoryConfig(E({ TOKENFACTORY_API_KEY: "  " }))).toBeNull();
  });
  it("defaults and overrides", () => {
    expect(loadTokenFactoryConfig(E({ TOKENFACTORY_API_KEY: "k" }))).toEqual({ apiKey: "k", baseUrl: TOKEN_FACTORY_BASE_URL, model: MEMORY_MODEL });
    expect(loadTokenFactoryConfig(E({ TOKENFACTORY_API_KEY: "k", TOKENFACTORY_BASE_URL: "https://x", HEARTH_MEMORY_MODEL: "m" }))).toEqual({ apiKey: "k", baseUrl: "https://x", model: "m" });
  });
  it("reads process.env by default", () => {
    vi.stubEnv("TOKENFACTORY_API_KEY", "");
    expect(loadTokenFactoryConfig()).toBeNull();
    vi.unstubAllEnvs();
  });
});

const CFG = { serviceAccountId: "sa-1", authKeyId: "key-1", privateKeyPem: PEM } as NebiusConfig;
const b64u = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString());

describe("signJwt", () => {
  it("produces a verifiable RS256 JWT with the right claims", () => {
    const jwt = signJwt(CFG, 1000);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(b64u(h)).toEqual({ alg: "RS256", typ: "JWT", kid: "key-1" });
    expect(b64u(p)).toEqual({ iss: "sa-1", sub: "sa-1", iat: 1000, exp: 1300 });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
  it("defaults iat to now", () => {
    const [, p] = signJwt(CFG).split(".") as [string, string];
    expect(Math.abs(b64u(p).iat - Date.now() / 1000)).toBeLessThan(5);
  });
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("token exchange", () => {
  beforeEach(() => resetTokenCache());
  afterEach(() => vi.useRealTimers());

  it("posts the token-exchange grant and returns the token with its expiry", async () => {
    const f = vi.fn(async () => ok({ access_token: "T", expires_in: 100, token_type: "Bearer" }));
    const t = await exchangeToken(CFG, f as never);
    expect(t.token).toBe("T");
    expect(t.expiresAtMs).toBeGreaterThan(Date.now() + 90_000);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.eu.nebius.com/oauth2/token/exchange");
    expect(String(init.body)).toContain("subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Ajwt");
  });

  it("includes the response body in a failed exchange", async () => {
    const f = async () => new Response("bad kid", { status: 401, statusText: "Unauthorized" });
    const err = await exchangeToken(CFG, f as never).catch((e) => e);
    expect(err).toBeInstanceOf(NebiusAuthError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("token exchange failed: 401 Unauthorized — bad kid");
  });

  it("survives an unreadable error body", async () => {
    const res = { ok: false, status: 500, statusText: "Boom", text: async () => { throw new Error("x"); } };
    const err = await exchangeToken(CFG, (async () => res) as never).catch((e) => e);
    expect(err.message).toBe("token exchange failed: 500 Boom");
  });

  it("rejects a response with no access_token as 502", async () => {
    const err = await exchangeToken(CFG, (async () => ok({})) as never).catch((e) => e);
    expect(err).toMatchObject({ name: "NebiusAuthError", status: 502 });
  });

  it("caches the token and re-mints inside the refresh margin", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => ok({ access_token: `T${f.mock.calls.length}`, expires_in: 3600 }));
    expect(await getAccessToken(CFG, f as never)).toBe("T1");
    expect(await getAccessToken(CFG, f as never)).toBe("T1");
    expect(f).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(51 * 60 * 1000);
    expect(await getAccessToken(CFG, f as never)).toBe("T2");
  });
});
