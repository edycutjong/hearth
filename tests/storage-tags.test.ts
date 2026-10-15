import { describe, expect, it } from "vitest";
import type { NebiusConfig } from "@/lib/nebius/config";
import { getObjectTagging } from "@/lib/nebius/storage";

const CONFIG = {
  region: "eu-west1", bucket: "hearth-data", s3Endpoint: "https://storage.eu-west1.nebius.cloud",
  s3AccessKeyId: "AKIDEXAMPLE", s3SecretAccessKey: "secret",
} as NebiusConfig;

/** The exact shape Nebius Object Storage answered on 2026-10-15: pretty-printed, newlines and indentation. */
const NEBIUS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Tagging>
 <TagSet>
  <Tag>
   <Key>space</Key>
   <Value>anon</Value>
  </Tag>
 </TagSet>
</Tagging>`;

const answer = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("object tags", () => {
  it("reads the pretty-printed tagging XML Nebius returns", async () => {
    expect(await getObjectTagging(CONFIG, "u/x/memory.json", answer(NEBIUS_XML))).toEqual({ space: "anon" });
  });
  it("reads compact XML too, and 404 as no object", async () => {
    expect(await getObjectTagging(CONFIG, "k", answer("<Tagging><TagSet><Tag><Key>space</Key><Value>kept</Value></Tag></TagSet></Tagging>"))).toEqual({ space: "kept" });
    expect(await getObjectTagging(CONFIG, "k", answer("", 404))).toBeNull();
  });
});
