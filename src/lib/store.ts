/**
 * The storage operations the app needs, as an interface: Nebius Object Storage in production
 * (`S3Store`), an in-memory twin in tests (`MemoryStore`) that keeps the S3 semantics that matter —
 * ETags, `If-Match` / `If-None-Match` (412), tags that are replaced on every write, HEAD 404 after DELETE,
 * and prefix listing.
 */

import { createHash } from "node:crypto";
import type { NebiusConfig } from "./nebius/config";
import * as s3 from "./nebius/storage";

export type Condition = { ifNoneMatch: "*" } | { ifMatch: string };

export interface Store {
  getText(key: string): Promise<string | null>;
  getBytes(key: string): Promise<Uint8Array | null>;
  getJson<T>(key: string): Promise<{ value: T; etag: string | null } | null>;
  put(key: string, body: string | Uint8Array, opts?: { tagging?: string; contentType?: string }): Promise<string | null>;
  putJson(key: string, value: unknown, opts?: { tagging?: string; condition?: Condition }): Promise<{ ok: boolean; etag: string | null }>;
  head(key: string): Promise<{ status: number; size: number | null }>;
  delete(key: string): Promise<number>;
  copy(from: string, to: string, tagging: string): Promise<void>;
  setTags(key: string, tags: Record<string, string>): Promise<void>;
  getTags(key: string): Promise<Record<string, string> | null>;
  list(prefix: string): Promise<Array<{ key: string; size: number }>>;
  presignGet(key: string, expiresSeconds: number): string;
  presignPut(key: string, expiresSeconds: number, tagging?: string): string;
}

export class S3Store implements Store {
  constructor(
    readonly config: NebiusConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  getText(key: string) {
    return s3.getObject(this.config, key, this.fetchImpl);
  }
  getBytes(key: string) {
    return s3.getBytes(this.config, key, this.fetchImpl);
  }
  async getJson<T>(key: string) {
    return s3.getJsonVersioned<T>(this.config, key, this.fetchImpl);
  }
  put(key: string, body: string | Uint8Array, opts: { tagging?: string; contentType?: string } = {}) {
    return s3.putObject(this.config, key, body, opts, this.fetchImpl);
  }
  async putJson(key: string, value: unknown, opts: { tagging?: string; condition?: Condition } = {}) {
    if (opts.condition) {
      const r = await s3.putJsonConditional(this.config, key, value, opts.condition, { tagging: opts.tagging }, this.fetchImpl);
      return r.ok ? { ok: true, etag: r.etag } : { ok: false, etag: null };
    }
    return { ok: true, etag: await s3.putJson(this.config, key, value, { tagging: opts.tagging }, this.fetchImpl) };
  }
  async head(key: string) {
    const h = await s3.headObject(this.config, key, this.fetchImpl);
    return { status: h.status, size: h.size };
  }
  delete(key: string) {
    return s3.deleteObject(this.config, key, this.fetchImpl);
  }
  copy(from: string, to: string, tagging: string) {
    return s3.copyObject(this.config, from, to, tagging, this.fetchImpl);
  }
  setTags(key: string, tags: Record<string, string>) {
    return s3.putObjectTagging(this.config, key, tags, this.fetchImpl);
  }
  getTags(key: string) {
    return s3.getObjectTagging(this.config, key, this.fetchImpl);
  }
  list(prefix: string) {
    return s3.listObjects(this.config, prefix, this.fetchImpl);
  }
  presignGet(key: string, expiresSeconds: number) {
    return s3.presignGet(this.config, key, expiresSeconds);
  }
  presignPut(key: string, expiresSeconds: number, tagging?: string) {
    return s3.presignPut(this.config, key, expiresSeconds, tagging);
  }
}

interface MemObject {
  body: Uint8Array;
  etag: string;
  tags: Record<string, string>;
}

function parseTagging(tagging: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (tagging ?? "").split("&").filter(Boolean)) {
    const [k, v] = pair.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return out;
}

/** In-memory S3 for tests. `presign*` return inert `mem://` URLs that tests can resolve with `resolveUrl`. */
export class MemoryStore implements Store {
  readonly objects = new Map<string, MemObject>();
  private seq = 0;

  private etag(body: Uint8Array): string {
    this.seq += 1;
    return `"${createHash("md5").update(body).update(String(this.seq)).digest("hex")}"`;
  }
  private bytes(body: string | Uint8Array): Uint8Array {
    return typeof body === "string" ? new TextEncoder().encode(body) : body;
  }
  async getText(key: string) {
    const o = this.objects.get(key);
    return o ? new TextDecoder().decode(o.body) : null;
  }
  async getBytes(key: string) {
    return this.objects.get(key)?.body ?? null;
  }
  async getJson<T>(key: string) {
    const o = this.objects.get(key);
    return o ? { value: JSON.parse(new TextDecoder().decode(o.body)) as T, etag: o.etag } : null;
  }
  async put(key: string, body: string | Uint8Array, opts: { tagging?: string } = {}) {
    const b = this.bytes(body);
    const etag = this.etag(b);
    this.objects.set(key, { body: b, etag, tags: parseTagging(opts.tagging) });
    return etag;
  }
  async putJson(key: string, value: unknown, opts: { tagging?: string; condition?: Condition } = {}) {
    const existing = this.objects.get(key);
    if (opts.condition) {
      if ("ifNoneMatch" in opts.condition && existing) return { ok: false, etag: null };
      if ("ifMatch" in opts.condition && (!existing || existing.etag !== opts.condition.ifMatch)) return { ok: false, etag: null };
    }
    return { ok: true, etag: await this.put(key, JSON.stringify(value), { tagging: opts.tagging }) };
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { status: 200, size: o.body.length } : { status: 404, size: null };
  }
  async delete(key: string) {
    this.objects.delete(key);
    return 204;
  }
  async copy(from: string, to: string, tagging: string) {
    const o = this.objects.get(from);
    if (!o) throw new Error(`COPY ${from}: 404`);
    this.objects.set(to, { body: o.body, etag: this.etag(o.body), tags: parseTagging(tagging) });
  }
  async setTags(key: string, tags: Record<string, string>) {
    const o = this.objects.get(key);
    if (o) o.tags = { ...tags };
  }
  async getTags(key: string) {
    return this.objects.get(key)?.tags ?? null;
  }
  async list(prefix: string) {
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, o]) => ({ key, size: o.body.length }));
  }
  presignGet(key: string, expiresSeconds: number) {
    return `mem://GET/${key}?expires=${expiresSeconds}`;
  }
  presignPut(key: string, expiresSeconds: number, tagging?: string) {
    return `mem://PUT/${key}?expires=${expiresSeconds}${tagging ? `&tag=${encodeURIComponent(tagging)}` : ""}`;
  }
  /** Tests: act as the holder of a presigned URL. */
  async resolveUrl(url: string, body?: string | Uint8Array): Promise<string | null> {
    const m = /^mem:\/\/(GET|PUT)\/([^?]+)(?:\?(.*))?$/.exec(url);
    if (!m) throw new Error(`not a memory URL: ${url}`);
    const [, method, key, qs] = m;
    if (method === "GET") return this.getText(key as string);
    const tag = new URLSearchParams(qs ?? "").get("tag") ?? undefined;
    await this.put(key as string, body ?? "", { tagging: tag });
    return null;
  }
}
