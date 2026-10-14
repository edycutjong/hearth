import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
