/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures: indexes are known to exist */
import { describe, expect, it, vi } from "vitest";

const s3 = vi.hoisted(() => {
  const fn = (name: string, ret?: unknown) => vi.fn(async (..._a: unknown[]) => ret ?? name);
  return {
    getObject: fn("text"), getBytes: fn("bytes"), getJsonVersioned: fn("jv"), putObject: fn("put"), putJson: fn("etag1"),
    putJsonConditional: vi.fn(async (..._a: unknown[]): Promise<{ ok: boolean; etag: string | null }> => ({ ok: true, etag: "e2" })),
    headObject: vi.fn(async (..._a: unknown[]) => ({ status: 200, size: 7, extra: 1 })),
    deleteObject: fn("del", 204), copyObject: fn("copy"), putObjectTagging: fn("tag"), getObjectTagging: fn("gt"), listObjects: fn("ls"),
    presignGet: vi.fn((..._a: unknown[]) => "GET-URL"), presignPut: vi.fn((..._a: unknown[]) => "PUT-URL"),
  };
});
vi.mock("@/lib/nebius/storage", () => s3);

import { MemoryStore, S3Store } from "@/lib/store";

describe("S3Store delegates to nebius/storage with its config and fetch", () => {
  const cfg = { bucket: "b" } as never;
  const f = vi.fn() as unknown as typeof fetch;
  const st = new S3Store(cfg, f);
  it("passes every call through", async () => {
    expect(await st.getText("k")).toBe("text");
    expect(await st.getBytes("k")).toBe("bytes");
    expect(await st.getJson("k")).toBe("jv");
    expect(await st.put("k", "x", { tagging: "a=b" })).toBe("put");
    expect(s3.putObject).toHaveBeenCalledWith(cfg, "k", "x", { tagging: "a=b" }, f);
    expect(await st.put("k", "x")).toBe("put");
    expect(await st.putJson("k", { a: 1 }, { tagging: "t" })).toEqual({ ok: true, etag: "etag1" });
    expect(await st.putJson("k", { a: 1 })).toEqual({ ok: true, etag: "etag1" });
    expect(await st.putJson("k", 1, { condition: { ifNoneMatch: "*" } })).toEqual({ ok: true, etag: "e2" });
    s3.putJsonConditional.mockResolvedValueOnce({ ok: false, etag: "stale" });
    expect(await st.putJson("k", 1, { condition: { ifMatch: "x" } })).toEqual({ ok: false, etag: null });
    expect(await st.head("k")).toEqual({ status: 200, size: 7 });
    expect(await st.delete("k")).toBe(204);
    await st.copy("a", "b", "t=1");
    expect(s3.copyObject).toHaveBeenCalledWith(cfg, "a", "b", "t=1", f);
    await st.setTags("k", { a: "b" });
    expect(await st.getTags("k")).toBe("gt");
    expect(await st.list("p")).toBe("ls");
    expect(st.presignGet("k", 5)).toBe("GET-URL");
    expect(st.presignPut("k", 5, "t=1")).toBe("PUT-URL");
    expect(s3.presignPut).toHaveBeenCalledWith(cfg, "k", 5, "t=1");
  });
  it("defaults fetch to global fetch", async () => {
    await new S3Store(cfg).getText("k");
    expect(s3.getObject).toHaveBeenLastCalledWith(cfg, "k", fetch);
  });
});

describe("MemoryStore semantics", () => {
  it("copy of a missing key throws; tagging parses empty values and skips blanks", async () => {
    const m = new MemoryStore();
    await expect(m.copy("nope", "x", "")).rejects.toThrow(/404/);
    await m.put("a", "1", { tagging: "k=v&flag&=skip&e%20x=a%26b" });
    expect(await m.getTags("a")).toEqual({ k: "v", flag: "", "e x": "a&b" });
    await m.copy("a", "b", "space=kept");
    expect(await m.getTags("b")).toEqual({ space: "kept" });
    expect(await m.getText("b")).toBe("1");
  });
  it("conditions, tags, head, list", async () => {
    const m = new MemoryStore();
    const first = await m.putJson("j", { v: 1 }, { condition: { ifNoneMatch: "*" } });
    expect(first.ok).toBe(true);
    expect((await m.putJson("j", { v: 2 }, { condition: { ifNoneMatch: "*" } })).ok).toBe(false);
    expect((await m.putJson("j", { v: 2 }, { condition: { ifMatch: "wrong" } })).ok).toBe(false);
    expect((await m.putJson("missing", 1, { condition: { ifMatch: "x" } })).ok).toBe(false);
    expect((await m.putJson("j", { v: 3 }, { condition: { ifMatch: first.etag! } })).ok).toBe(true);
    expect((await m.getJson<{ v: number }>("j"))?.value.v).toBe(3);
    expect(await m.getJson("none")).toBeNull();
    expect(await m.getText("none")).toBeNull();
    expect(await m.getBytes("none")).toBeNull();
    expect(await m.getTags("none")).toBeNull();
    await m.setTags("none", { a: "b" });
    await m.setTags("j", { a: "b" });
    expect(await m.getTags("j")).toEqual({ a: "b" });
    expect(await m.head("none")).toEqual({ status: 404, size: null });
    await m.put("p/b", new Uint8Array(3));
    await m.put("p/a", "xy");
    expect(await m.list("p/")).toEqual([{ key: "p/a", size: 2 }, { key: "p/b", size: 3 }]);
    expect(await m.delete("p/a")).toBe(204);
    expect(await m.head("p/a")).toEqual({ status: 404, size: null });
  });
  it("presign + resolveUrl round trip", async () => {
    const m = new MemoryStore();
    expect(m.presignGet("k", 9)).toBe("mem://GET/k?expires=9");
    const put = m.presignPut("k", 9, "space=anon");
    expect(await m.resolveUrl(put, "hello")).toBeNull();
    expect(await m.getTags("k")).toEqual({ space: "anon" });
    expect(await m.resolveUrl(m.presignGet("k", 9))).toBe("hello");
    await m.resolveUrl(m.presignPut("e", 9));
    expect(await m.getText("e")).toBe("");
    await m.resolveUrl("mem://PUT/bare", "z");
    expect(await m.getText("bare")).toBe("z");
    await m.put("nq", "q");
    expect(await m.resolveUrl("mem://GET/nq")).toBe("q");
    await expect(m.resolveUrl("https://x")).rejects.toThrow(/not a memory URL/);
  });
});
