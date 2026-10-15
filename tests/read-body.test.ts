import { describe, expect, it } from "vitest";
import { readBody } from "@/lib/server";

const req = (body: string) => new Request("https://hearth.test/api/x", { method: "POST", body, headers: { "content-type": "application/json" } });

describe("request bodies", () => {
  it.each([["null"], ["[1,2]"], ["5"], ['"text"'], ["{broken"], [""]])("reads %s as an empty object, never a crash", async (body) => {
    expect(await readBody<{ files: unknown[] }>(req(body))).toEqual({});
  });
  it("passes an object through", async () => {
    expect(await readBody<{ files: unknown[] }>(req('{"files":[]}'))).toEqual({ files: [] });
  });
});
