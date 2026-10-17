import { describe, expect, it } from "vitest";
import { canonicalQueryString, canonicalUri, presignUrl, signRequest, uriEncode } from "@/lib/nebius/sigv4";

const BASE = { region: "eu-west1", service: "s3", accessKeyId: "AK", secretAccessKey: "SK" };

describe("sigv4 defaults and edge inputs", () => {
  it("uriEncode keeps slashes only when asked and escapes RFC 3986 extras", () => {
    expect(uriEncode("a b/c!(*)'", false)).toBe("a%20b/c%21%28%2A%29%27");
    expect(uriEncode("a/b", true)).toBe("a%2Fb");
  });
  it("signs headers sorted by lowercase name, including case-colliding duplicates", () => {
    const s = signRequest({ ...BASE, method: "PUT", path: "/b/k", headers: { Zed: "1", Alpha: " a   b ", alpha: "x" }, payload: "", date: new Date("2026-01-01T00:00:00Z") });
    const signed = s.canonicalRequest.split("\n").at(-2);
    expect(signed).toBe("alpha;alpha;x-amz-content-sha256;x-amz-date;zed");
    expect(s.canonicalRequest).toContain("alpha:a b\n");
  });
  it("canonicalUri maps empty and root to /", () => {
    expect(canonicalUri("")).toBe("/");
    expect(canonicalUri("/")).toBe("/");
  });
  it("canonicalQueryString treats an undefined value as empty", () => {
    expect(canonicalQueryString({ b: "2", a: undefined as unknown as string })).toBe("a=&b=2");
  });
  it("signRequest defaults the date to now and the query to empty", () => {
    const s = signRequest({ ...BASE, method: "get", path: "/b/k", headers: { Host: "h" }, payload: "" });
    const stamp = s.headers["x-amz-date"] as string;
    expect(stamp).toMatch(/^\d{8}T\d{6}Z$/);
    expect(Date.now() - Date.parse(stamp.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"))).toBeLessThan(5000);
    expect(s.canonicalRequest.split("\n")[2]).toBe("");
    expect(s.canonicalRequest.startsWith("GET\n")).toBe(true);
    expect(s.headers.Authorization).toContain("Credential=AK/");
  });
  it("presignUrl binds extra headers (lowercased, trimmed) into the signature", () => {
    const p = presignUrl({ ...BASE, method: "PUT", origin: "https://h", path: "/b/k", expiresSeconds: 60, signedHeaders: { "X-Amz-Tagging": " space=anon " }, date: new Date("2026-01-01T00:00:00Z") });
    expect(p.url).toContain("X-Amz-SignedHeaders=host%3Bx-amz-tagging");
    expect(p.canonicalRequest).toContain("x-amz-tagging:space=anon\n");
  });
  it("presignUrl defaults date and signed headers, and clamps the lifetime", () => {
    const p = presignUrl({ ...BASE, method: "GET", origin: "https://h/", path: "/b/k", expiresSeconds: 99_999_999 });
    expect(p.url).toContain("X-Amz-Expires=604800");
    expect(p.url).toContain("X-Amz-SignedHeaders=host&");
    expect(p.url.startsWith("https://h/b/k?")).toBe(true);
    expect(presignUrl({ ...BASE, method: "GET", origin: "https://h", path: "/b/k", expiresSeconds: 0 }).url).toContain("X-Amz-Expires=1&");
  });
});
