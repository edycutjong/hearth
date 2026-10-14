import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hctSeconds, readHctCodes } from "@/lib/hct";

describe(".hct written by the Python worker, read in TypeScript", () => {
  const fx = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/hct-v2.json"), "utf8")) as { b64: string; codes: number[][] };
  const buf = Uint8Array.from(Buffer.from(fx.b64, "base64")).buffer;
  it("reads the header", () => {
    const { header } = readHctCodes(buf);
    expect(header).toMatchObject({ version: 2, codebooks: 13, codebookSize: 2016, sampleRate: 22050, samplesPerFrame: 1764, frames: 40, windows: [25, 15], leadFrames: 3, contextFrames: 25, gainDb: -3.5 });
    expect(hctSeconds(header)).toBeCloseTo((40 * 1764 - 500) / 22050, 6);
  });
  it("unpacks every 11-bit code exactly", () => {
    const { codes } = readHctCodes(buf);
    expect(codes.map((row) => Array.from(row))).toEqual(fx.codes);
  });
  it("rejects anything else", () => {
    expect(() => readHctCodes(new Uint8Array(64).buffer)).toThrow();
  });
});
