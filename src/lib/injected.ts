/**
 * The files injected into every Job. The Jobs API encrypts all injected files together and refuses more than 64 KiB
 * of them in total after base64 ("plaintext must not exceed 65536 bytes", evidence/injected-files-limit.json; the docs
 * say 64 KiB per file). So the worker and its pinned requirements travel gzipped, and run.sh unpacks them.
 */

import { gzipSync } from "node:zlib";
import type { InjectedFile } from "./nebius/jobs";
import { REQUIREMENTS_SOURCE, RUN_SOURCE, WORKER_SOURCE } from "./worker-source";

const gz = (text: string) => gzipSync(Buffer.from(text, "utf8"), { level: 9 }).toString("base64");

export function injectedFiles(): InjectedFile[] {
  return [
    { containerPath: "/opt/hearth/run.sh", content: RUN_SOURCE },
    { containerPath: "/opt/hearth/worker.py.gz", content: gz(WORKER_SOURCE), encoding: "base64" },
    { containerPath: "/opt/hearth/requirements.txt.gz", content: gz(REQUIREMENTS_SOURCE), encoding: "base64" },
  ];
}

/** Bytes of base64 the API counts against its 64 KiB total. */
export function injectedBase64Total(files: InjectedFile[] = injectedFiles()): number {
  return files.reduce((n, f) => n + (f.encoding === "base64" ? f.content.length : Buffer.from(f.content, "utf8").toString("base64").length), 0);
}
