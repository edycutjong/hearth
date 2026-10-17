import { describe, expect, it } from "vitest";
import type { NebiusConfig } from "@/lib/nebius/config";
import {
  StorageError,
  copyObject,
  decodeXmlEntities,
  deleteObject,
  getBytes,
  getJson,
  getJsonVersioned,
  getObject,
  getObjectTagging,
  headObject,
  headStatus,
  listObjects,
  presignGet,
  presignPut,
  putJson,
  putJsonConditional,
  putObject,
  putObjectTagging,
} from "@/lib/nebius/storage";

const CFG = {
  region: "eu-west1", bucket: "hearth-data", s3Endpoint: "https://storage.eu-west1.nebius.cloud/",
  s3AccessKeyId: "AK", s3SecretAccessKey: "SK",
} as NebiusConfig;

import { must } from "./helpers";
const at = <T,>(a: T[], i: number): T => must(a[i]);

interface Seen { url: string; method: string; headers: Record<string, string>; body?: unknown }

function fake(reply: (n: number, seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const s = { url, method: init.method as string, headers: init.headers as Record<string, string>, body: init.body };
    seen.push(s);
    return reply(seen.length - 1, s);
  }) as unknown as typeof fetch;
  return { f, seen };
}
const r = (body: string | null, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });

describe("reads", () => {
  it("getObject: text, 404 -> null, other errors throw StorageError", async () => {
    const a = fake(() => r("hi"));
    expect(await getObject(CFG, "u/x y.txt", a.f)).toBe("hi");
    expect(at(a.seen, 0).url).toBe("https://storage.eu-west1.nebius.cloud/hearth-data/u/x y.txt");
    expect(at(a.seen, 0).headers.Host).toBeUndefined();
    expect(at(a.seen, 0).headers.Authorization).toContain("AWS4-HMAC-SHA256 Credential=AK/");
    expect(at(a.seen, 0).body).toBeUndefined();
    expect(await getObject(CFG, "k", fake(() => r("", 404)).f)).toBeNull();
    const err = await getObject(CFG, "k", fake(() => r("", 500)).f).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err).toMatchObject({ status: 500, message: "GET k failed: 500" });
  });

  it("getBytes mirrors getObject for binary", async () => {
    expect(await getBytes(CFG, "k", fake(() => new Response(new Uint8Array([1, 2, 3]))).f)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await getBytes(CFG, "k", fake(() => r("", 404)).f)).toBeNull();
    await expect(getBytes(CFG, "k", fake(() => r("", 403)).f)).rejects.toMatchObject({ status: 403 });
  });

  it("getJson parses, and yields null for absent or unparseable", async () => {
    expect(await getJson(CFG, "k", fake(() => r('{"a":1}')).f)).toEqual({ a: 1 });
    expect(await getJson(CFG, "k", fake(() => r("", 404)).f)).toBeNull();
    expect(await getJson(CFG, "k", fake(() => r("{half")).f)).toBeNull();
  });

  it("getJsonVersioned returns value + etag, null on 404, throws on error or non-JSON", async () => {
    expect(await getJsonVersioned(CFG, "k", fake(() => r('{"a":1}', 200, { etag: '"e1"' })).f)).toEqual({ value: { a: 1 }, etag: '"e1"' });
    expect(await getJsonVersioned(CFG, "k", fake(() => r('{}')).f)).toEqual({ value: {}, etag: null });
    expect(await getJsonVersioned(CFG, "k", fake(() => r("", 404)).f)).toBeNull();
    await expect(getJsonVersioned(CFG, "k", fake(() => r("", 500)).f)).rejects.toMatchObject({ status: 500 });
    await expect(getJsonVersioned(CFG, "k", fake(() => r("<html>")).f)).rejects.toMatchObject({ status: 500, message: expect.stringContaining("not JSON") });
  });
});

describe("writes", () => {
  it("putObject sends string and bytes with tag + content type, returns etag", async () => {
    const a = fake(() => r("", 200, { etag: '"abc"' }));
    expect(await putObject(CFG, "k", "body", { tagging: "space=anon", contentType: "text/plain" }, a.f)).toBe('"abc"');
    expect(a.seen[0]).toMatchObject({ method: "PUT", url: "https://storage.eu-west1.nebius.cloud/hearth-data/k" });
    expect(at(a.seen, 0).headers["x-amz-tagging"]).toBe("space=anon");
    expect(at(a.seen, 0).headers["content-type"]).toBe("text/plain");
    expect(at(a.seen, 0).body).toBe("body");
    await putObject(CFG, "k", new Uint8Array([9]), undefined, a.f);
    expect(Buffer.from(at(a.seen, 1).body as Buffer)).toEqual(Buffer.from([9]));
    expect(at(a.seen, 1).headers["x-amz-tagging"]).toBeUndefined();
    expect(await putObject(CFG, "k", "x", {}, fake(() => r("")).f)).toBeNull();
    await expect(putObject(CFG, "k", "x", {}, fake(() => r("", 500)).f)).rejects.toMatchObject({ status: 500, message: "PUT k failed: 500" });
  });

  it("putJson serialises with a JSON content type that options can override", async () => {
    const a = fake(() => r(""));
    await putJson(CFG, "k", { a: 1 }, { tagging: "space=kept" }, a.f);
    expect(at(a.seen, 0).body).toBe('{"a":1}');
    expect(at(a.seen, 0).headers["content-type"]).toBe("application/json");
    await putJson(CFG, "k", [], { contentType: "x/y" }, a.f);
    expect(at(a.seen, 1).headers["content-type"]).toBe("x/y");
    await putJson(CFG, "k", 1, undefined, a.f);
    expect(at(a.seen, 2).body).toBe("1");
  });

  it("putJsonConditional: If-None-Match / If-Match, lost races are ordinary, other failures throw", async () => {
    const a = fake(() => r("", 200, { etag: '"n"' }));
    expect(await putJsonConditional(CFG, "k", { v: 1 }, { ifNoneMatch: "*" }, { tagging: "space=anon" }, a.f)).toEqual({ ok: true, etag: '"n"' });
    expect(at(a.seen, 0).headers["If-None-Match"]).toBe("*");
    expect(at(a.seen, 0).headers["x-amz-tagging"]).toBe("space=anon");
    await putJsonConditional(CFG, "k", {}, { ifMatch: '"e"' }, undefined, a.f);
    expect(at(a.seen, 1).headers["If-Match"]).toBe('"e"');
    expect(at(a.seen, 1).headers["If-None-Match"]).toBeUndefined();
    for (const status of [412, 409]) {
      expect(await putJsonConditional(CFG, "k", {}, { ifMatch: "e" }, {}, fake(() => r("", status)).f)).toEqual({ ok: false, status });
    }
    expect(await putJsonConditional(CFG, "k", {}, { ifMatch: "e" }, {}, fake(() => r("")).f)).toEqual({ ok: true, etag: null });
    await expect(putJsonConditional(CFG, "k", {}, { ifMatch: "e" }, {}, fake(() => r("", 500)).f)).rejects.toMatchObject({ status: 500 });
  });
});

describe("head / delete / copy", () => {
  it("headStatus and headObject report status, size and etag", async () => {
    const a = fake(() => r(null, 200, { "content-length": "42", etag: '"e"' }));
    expect(await headStatus(CFG, "k", a.f)).toBe(200);
    expect(at(a.seen, 0).method).toBe("HEAD");
    expect(await headObject(CFG, "k", a.f)).toEqual({ status: 200, size: 42, etag: '"e"' });
    expect(await headObject(CFG, "k", fake(() => r(null, 404)).f)).toEqual({ status: 404, size: null, etag: null });
  });

  it("deleteObject tolerates 404 and throws on real failures", async () => {
    const a = fake(() => r(null, 204));
    expect(await deleteObject(CFG, "k", a.f)).toBe(204);
    expect(at(a.seen, 0).method).toBe("DELETE");
    expect(at(a.seen, 0).body).toBeUndefined();
    expect(await deleteObject(CFG, "k", fake(() => r(null, 404)).f)).toBe(404);
    await expect(deleteObject(CFG, "k", fake(() => r(null, 403)).f)).rejects.toMatchObject({ status: 403, message: "DELETE k failed: 403" });
  });

  it("copyObject replaces tags and encodes the source path per segment", async () => {
    const a = fake(() => r(""));
    await copyObject(CFG, "u/a b/c.opus", "u/kept/c.opus", "space=kept", a.f);
    expect(at(a.seen, 0).headers["x-amz-copy-source"]).toBe("/hearth-data/u/a%20b/c.opus");
    expect(at(a.seen, 0).headers["x-amz-tagging-directive"]).toBe("REPLACE");
    expect(at(a.seen, 0).headers["x-amz-tagging"]).toBe("space=kept");
    expect(at(a.seen, 0).url).toContain("/u/kept/c.opus");
    await expect(copyObject(CFG, "a", "b", "t", fake(() => r("", 404)).f)).rejects.toMatchObject({ status: 404, message: "COPY a -> b failed: 404" });
  });
});

describe("tagging", () => {
  it("putObjectTagging writes escaped XML to ?tagging", async () => {
    const a = fake(() => r(""));
    await putObjectTagging(CFG, "k", { space: "kept", "a&b": `<"'>` }, a.f);
    expect(at(a.seen, 0).url).toBe("https://storage.eu-west1.nebius.cloud/hearth-data/k?tagging=");
    expect(at(a.seen, 0).headers["content-type"]).toBe("application/xml");
    expect(at(a.seen, 0).body).toBe(
      "<Tagging><TagSet><Tag><Key>space</Key><Value>kept</Value></Tag><Tag><Key>a&amp;b</Key><Value>&lt;&quot;&apos;&gt;</Value></Tag></TagSet></Tagging>",
    );
    await expect(putObjectTagging(CFG, "k", {}, fake(() => r("", 500)).f)).rejects.toMatchObject({ message: "PUT tagging k failed: 500" });
  });

  it("getObjectTagging throws on non-404 errors and decodes entities", async () => {
    await expect(getObjectTagging(CFG, "k", fake(() => r("", 500)).f)).rejects.toMatchObject({ message: "GET tagging k failed: 500" });
    expect(await getObjectTagging(CFG, "k", fake(() => r("<Tag><Key>a&amp;b</Key><Value>&lt;x&gt;</Value></Tag>")).f)).toEqual({ "a&b": "<x>" });
    expect(await getObjectTagging(CFG, "k", fake(() => r("<Tagging/>")).f)).toEqual({});
  });

  it("decodeXmlEntities is single-pass", () => {
    expect(decodeXmlEntities("&amp;lt; &quot;&apos;")).toBe("&lt; \"'");
  });
});

describe("listObjects", () => {
  const page = (keys: Array<[string, string?]>, next?: string) =>
    `<ListBucketResult>${keys.map(([k, s]) => `<Contents><Key>${k}</Key>${s ? `<Size>${s}</Size>` : ""}</Contents>`).join("")}` +
    (next ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${next}</NextContinuationToken>` : "<IsTruncated>false</IsTruncated>") +
    `</ListBucketResult>`;

  it("follows continuation tokens and decodes keys; missing size is 0", async () => {
    const a = fake((n) => r(n === 0 ? page([["a&amp;b", "5"], ["c"]], "TOK") : page([["d", "7"]])));
    expect(await listObjects(CFG, "u/", a.f)).toEqual([{ key: "a&b", size: 5 }, { key: "c", size: 0 }, { key: "d", size: 7 }]);
    expect(at(a.seen, 0).url).toBe("https://storage.eu-west1.nebius.cloud/hearth-data?list-type=2&prefix=u%2F");
    expect(at(a.seen, 1).url).toContain("continuation-token=TOK");
  });

  it("stops when truncated without a token, skips key-less blocks, and throws on error", async () => {
    const xml = "<R><Contents><Size>1</Size></Contents><IsTruncated>true</IsTruncated></R>";
    expect(await listObjects(CFG, "p", fake(() => r(xml)).f)).toEqual([]);
    await expect(listObjects(CFG, "p", fake(() => r("", 500)).f)).rejects.toMatchObject({ message: "LIST p failed: 500" });
  });
});

describe("presigned URLs", () => {
  const date = new Date("2026-10-15T00:00:00Z");
  it("presignGet scopes the URL to one key", () => {
    const u = new URL(presignGet(CFG, "/u/x y.opus", 600, date));
    expect(u.origin + u.pathname).toBe("https://storage.eu-west1.nebius.cloud/hearth-data/u/x%20y.opus");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Amz-Date")).toBe("20261015T000000Z");
  });
  it("presignPut binds the tag into the signature only when given", () => {
    const tagged = new URL(presignPut(CFG, "k", 60, "space=anon", date));
    expect(tagged.searchParams.get("X-Amz-SignedHeaders")).toBe("host;x-amz-tagging");
    const plain = new URL(presignPut(CFG, "k", 60, undefined, date));
    expect(plain.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(tagged.searchParams.get("X-Amz-Signature")).not.toBe(plain.searchParams.get("X-Amz-Signature"));
    expect(presignGet(CFG, "k", 60)).toContain("X-Amz-Signature=");
  });
});
