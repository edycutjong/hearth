/**
 * Nebius Object Storage (S3-compatible) client — Hearth's only database.
 *
 * There is no SQL database: a space is a key prefix, memory is one JSON object rewritten with
 * `If-Match` (412 on a concurrent change), and the queue and the daily caps are small JSON objects.
 * Deletion is verifiable because it is ours: the app DELETEs a key with its own credentials and then
 * HEADs it, and only a 404 counts as deleted. No Job ever holds a credential or a delete right.
 */

import { presignUrl, signRequest } from "./sigv4";
import type { NebiusConfig } from "./config";

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/** Path-style addressing (`https://storage.<region>.nebius.cloud/<bucket>/<key>`), as the Nebius docs document. */
function objectUrl(config: NebiusConfig, key: string): string {
  const base = config.s3Endpoint.replace(/\/+$/, "");
  return key ? `${base}/${config.bucket}/${key.replace(/^\/+/, "")}` : `${base}/${config.bucket}`;
}

async function s3Request(
  config: NebiusConfig,
  method: string,
  key: string,
  body: string | Uint8Array,
  query: Record<string, string>,
  fetchImpl: typeof fetch,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const url = objectUrl(config, key);
  const path = new URL(url).pathname;
  const payload = typeof body === "string" ? body : Buffer.from(body);
  // Conditional and tagging headers are signed along with Host, so they cannot be stripped in transit.
  const signed = signRequest({
    method,
    path: decodeURIComponent(path),
    query,
    headers: { Host: new URL(config.s3Endpoint).host, ...extraHeaders },
    payload,
    region: config.region,
    service: "s3",
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
  });
  // `Host` is signed but must not be sent explicitly — fetch sets it, and a duplicate is a protocol error.
  const headers = { ...signed.headers };
  delete headers.Host;
  const qs = new URLSearchParams(query).toString();
  return fetchImpl(qs ? `${url}?${qs}` : url, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" || method === "DELETE" ? {} : { body: payload }),
  });
}

/** Read an object. Returns null for a missing key. */
export async function getObject(config: NebiusConfig, key: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await s3Request(config, "GET", key, "", {}, fetchImpl);
  if (res.status === 404) return null;
  if (!res.ok) throw new StorageError(`GET ${key} failed: ${res.status}`, res.status);
  return res.text();
}

export async function getBytes(config: NebiusConfig, key: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array | null> {
  const res = await s3Request(config, "GET", key, "", {}, fetchImpl);
  if (res.status === 404) return null;
  if (!res.ok) throw new StorageError(`GET ${key} failed: ${res.status}`, res.status);
  return new Uint8Array(await res.arrayBuffer());
}

/** Read and parse JSON; null when absent or unparseable (a worker document that is not finished yet). */
export async function getJson<T>(config: NebiusConfig, key: string, fetchImpl: typeof fetch = fetch): Promise<T | null> {
  const text = await getObject(config, key, fetchImpl);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export interface PutOptions {
  /** `space=anon` or `space=kept`. Sent on EVERY write: the docs do not promise tags survive an overwrite. */
  tagging?: string;
  contentType?: string;
}

function putHeaders(opts: PutOptions): Record<string, string> {
  const h: Record<string, string> = {};
  if (opts.tagging) h["x-amz-tagging"] = opts.tagging;
  if (opts.contentType) h["content-type"] = opts.contentType;
  return h;
}

export async function putObject(
  config: NebiusConfig,
  key: string,
  body: string | Uint8Array,
  opts: PutOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await s3Request(config, "PUT", key, body, {}, fetchImpl, putHeaders(opts));
  if (!res.ok) throw new StorageError(`PUT ${key} failed: ${res.status}`, res.status);
  return res.headers.get("etag");
}

export async function putJson(
  config: NebiusConfig,
  key: string,
  value: unknown,
  opts: PutOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  return putObject(config, key, JSON.stringify(value), { contentType: "application/json", ...opts }, fetchImpl);
}

/** HEAD a key and return the HTTP status (200 present, 404 gone): the deletion proof is this number. */
export async function headStatus(config: NebiusConfig, key: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await s3Request(config, "HEAD", key, "", {}, fetchImpl);
  return res.status;
}

export async function headObject(
  config: NebiusConfig,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; size: number | null; etag: string | null }> {
  const res = await s3Request(config, "HEAD", key, "", {}, fetchImpl);
  const len = res.headers.get("content-length");
  return { status: res.status, size: len === null ? null : Number(len), etag: res.headers.get("etag") };
}

/** DELETE a key. S3 answers 204 whether or not it existed, which is why callers HEAD afterwards. */
export async function deleteObject(config: NebiusConfig, key: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await s3Request(config, "DELETE", key, "", {}, fetchImpl);
  if (!res.ok && res.status !== 404) throw new StorageError(`DELETE ${key} failed: ${res.status}`, res.status);
  return res.status;
}

/**
 * Server-side copy with the tag REPLACED (`x-amz-tagging-directive: REPLACE`), so an original kept on purpose
 * carries the space's tag and still expires with an anonymous space.
 */
export async function copyObject(
  config: NebiusConfig,
  fromKey: string,
  toKey: string,
  tagging: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await s3Request(config, "PUT", toKey, "", {}, fetchImpl, {
    "x-amz-copy-source": `/${config.bucket}/${fromKey.split("/").map(encodeURIComponent).join("/")}`,
    "x-amz-tagging-directive": "REPLACE",
    "x-amz-tagging": tagging,
  });
  if (!res.ok) throw new StorageError(`COPY ${fromKey} -> ${toKey} failed: ${res.status}`, res.status);
}

/** Replace an object's tag set (Keep my space re-tags `space=anon` -> `space=kept`). */
export async function putObjectTagging(
  config: NebiusConfig,
  key: string,
  tags: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const xml =
    `<Tagging><TagSet>` +
    Object.entries(tags)
      .map(([k, v]) => `<Tag><Key>${escapeXml(k)}</Key><Value>${escapeXml(v)}</Value></Tag>`)
      .join("") +
    `</TagSet></Tagging>`;
  const res = await s3Request(config, "PUT", key, xml, { tagging: "" }, fetchImpl, { "content-type": "application/xml" });
  if (!res.ok) throw new StorageError(`PUT tagging ${key} failed: ${res.status}`, res.status);
}

export async function getObjectTagging(
  config: NebiusConfig,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string> | null> {
  const res = await s3Request(config, "GET", key, "", { tagging: "" }, fetchImpl);
  if (res.status === 404) return null;
  if (!res.ok) throw new StorageError(`GET tagging ${key} failed: ${res.status}`, res.status);
  const xml = await res.text();
  const out: Record<string, string> = {};
  // Nebius answers pretty-printed XML (newlines and indentation between the elements): match with whitespace allowed.
  for (const m of xml.matchAll(/<Tag>\s*<Key>([^<]*)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g)) {
    out[decodeXmlEntities(m[1] ?? "")] = decodeXmlEntities(m[2] ?? "");
  }
  return out;
}

export interface ListedObject {
  key: string;
  size: number;
}

/** List objects under a prefix (ListObjectsV2), following continuation tokens to completion. */
export async function listObjects(config: NebiusConfig, prefix: string, fetchImpl: typeof fetch = fetch): Promise<ListedObject[]> {
  const out: ListedObject[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (token) query["continuation-token"] = token;
    const res = await s3Request(config, "GET", "", "", query, fetchImpl);
    if (!res.ok) throw new StorageError(`LIST ${prefix} failed: ${res.status}`, res.status);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1] ?? "";
      const key = block.match(/<Key>([^<]*)<\/Key>/)?.[1];
      const size = block.match(/<Size>(\d+)<\/Size>/)?.[1];
      if (key !== undefined) out.push({ key: decodeXmlEntities(key), size: Number(size ?? 0) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? (xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1] ?? undefined)
      : undefined;
  } while (token);
  return out;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** One pass, so a key holding a literal "&lt;" (sent as "&amp;lt;") is not decoded twice. */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? "");
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" }[c]};`);
}

/** A stored object together with the ETag a conditional replace must quote back. */
export interface Versioned<T> {
  value: T;
  etag: string | null;
}

export async function getJsonVersioned<T>(
  config: NebiusConfig,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Versioned<T> | null> {
  const res = await s3Request(config, "GET", key, "", {}, fetchImpl);
  if (res.status === 404) return null;
  if (!res.ok) throw new StorageError(`GET ${key} failed: ${res.status}`, res.status);
  const text = await res.text();
  try {
    return { value: JSON.parse(text) as T, etag: res.headers.get("etag") };
  } catch {
    throw new StorageError(`GET ${key} returned a document that is not JSON`, 500);
  }
}

/** Create-only (`ifNoneMatch: "*"`) or replace-if-unchanged (`ifMatch: <etag>`). */
export type WriteCondition = { ifNoneMatch: "*" } | { ifMatch: string };
export type ConditionalResult = { ok: true; etag: string | null } | { ok: false; status: number };

/**
 * A conditional PUT. Losing the condition is an ordinary outcome: 412 means the object exists (or changed)
 * and 409 means a concurrent conditional write is in flight. Either way the caller re-reads and re-merges.
 */
export async function putJsonConditional(
  config: NebiusConfig,
  key: string,
  value: unknown,
  condition: WriteCondition,
  opts: PutOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ConditionalResult> {
  const header: Record<string, string> =
    "ifNoneMatch" in condition ? { "If-None-Match": condition.ifNoneMatch } : { "If-Match": condition.ifMatch };
  const res = await s3Request(config, "PUT", key, JSON.stringify(value), {}, fetchImpl, {
    ...header,
    ...putHeaders({ contentType: "application/json", ...opts }),
  });
  if (res.status === 412 || res.status === 409) return { ok: false, status: res.status };
  if (!res.ok) throw new StorageError(`PUT ${key} failed: ${res.status}`, res.status);
  return { ok: true, etag: res.headers.get("etag") };
}

function presign(
  config: NebiusConfig,
  method: "GET" | "PUT",
  key: string,
  expiresSeconds: number,
  signedHeaders?: Record<string, string>,
  date?: Date,
): string {
  const url = new URL(objectUrl(config, key));
  return presignUrl({
    method,
    origin: url.origin,
    path: decodeURIComponent(url.pathname),
    region: config.region,
    service: "s3",
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    expiresSeconds,
    signedHeaders,
    date,
  }).url;
}

/** A URL that lets its holder GET exactly one key until it expires. */
export function presignGet(config: NebiusConfig, key: string, expiresSeconds: number, date?: Date): string {
  return presign(config, "GET", key, expiresSeconds, undefined, date);
}

/**
 * A URL that lets its holder PUT exactly one key until it expires — and nothing else. With `tagging`, the tag
 * is inside the signature: the uploader must send `x-amz-tagging` with exactly that value.
 */
export function presignPut(
  config: NebiusConfig,
  key: string,
  expiresSeconds: number,
  tagging?: string,
  date?: Date,
): string {
  return presign(config, "PUT", key, expiresSeconds, tagging ? { "x-amz-tagging": tagging } : undefined, date);
}
