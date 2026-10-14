import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { injectedBase64Total, injectedFiles } from "@/lib/injected";
import { DECODE_SOURCE, REQUIREMENTS_SOURCE, RUN_SOURCE, WORKER_SOURCE } from "@/lib/worker-source";

const read = (rel: string) => readFileSync(path.resolve(__dirname, "..", rel), "utf8");

describe("the worker the app injects is the worker in the repo", () => {
  it.each([
    ["worker/worker.py", WORKER_SOURCE],
    ["worker/run.sh", RUN_SOURCE],
    ["worker/requirements.txt", REQUIREMENTS_SOURCE],
    ["export/decode.py", DECODE_SOURCE],
  ])("%s is embedded verbatim (run `npm run embed-worker` after editing it)", (rel, embedded) => {
    expect(createHash("sha256").update(embedded).digest("hex")).toBe(createHash("sha256").update(read(rel)).digest("hex"));
  });
  it("fits the Jobs API's 64 KiB injected-file limit", () => {
    for (const s of [WORKER_SOURCE, RUN_SOURCE, REQUIREMENTS_SOURCE]) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("what a Job receives", () => {
  const unpack = (f: { content: string; encoding?: string }) =>
    f.encoding === "base64" ? gunzipSync(Buffer.from(f.content, "base64")).toString("utf8") : f.content;

  it("unpacks to exactly the repo's worker, run script and pinned requirements", () => {
    const files = Object.fromEntries(injectedFiles().map((f) => [f.containerPath, unpack(f)]));
    expect(files["/opt/hearth/run.sh"]).toBe(read("worker/run.sh"));
    expect(files["/opt/hearth/worker.py.gz"]).toBe(read("worker/worker.py"));
    expect(files["/opt/hearth/requirements.txt.gz"]).toBe(read("worker/requirements.txt"));
  });

  it("stays under the 64 KiB the API allows for ALL injected files together, after base64", () => {
    // evidence/injected-files-limit.json: 65,804 B of base64 across three plain files was refused.
    expect(injectedBase64Total()).toBeLessThanOrEqual(64 * 1024);
    const plain = [WORKER_SOURCE, RUN_SOURCE, REQUIREMENTS_SOURCE].reduce((n, s) => n + Buffer.from(s).toString("base64").length, 0);
    expect(injectedBase64Total()).toBeLessThan(plain / 2);
  });
});
