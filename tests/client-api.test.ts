import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/components/app/types";

describe("the client's request helper", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers a network failure instead of throwing, so polling and buttons never freeze", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await api<{ error?: string }>("/api/status");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.data.error).toMatch(/connection/);
  });

  it("passes a server answer through", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ space: null }), { status: 200 }));
    expect(await api<{ space: null }>("/api/status")).toEqual({ ok: true, status: 200, data: { space: null } });
  });
});
