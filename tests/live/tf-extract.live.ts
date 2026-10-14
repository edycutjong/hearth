/**
 * One live Token Factory call: Nemotron 3 Super extracts from a short Hindi transcript written for this test
 * (the judge-sample script's N1 lines; no real family audio), and the gates judge what it proposed.
 * Writes evidence/tf-extract-smoke.json (request id, model, latency, proposals, gate outcomes).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveDue } from "@/lib/dates";
import { fieldGate, quoteGate, type Segment } from "@/lib/gates";
import { loadTokenFactoryConfig } from "@/lib/nebius/config";
import { extract } from "@/lib/tf";

const SEGMENTS: Segment[] = [
  { i: 0, t0: 0, t1: 2.4, text: "बेटा, कैसे हो?" },
  { i: 1, t0: 2.4, t1: 8.8, text: "मेरे घुटने में फिर से दर्द है, डॉक्टर ने सोमवार को बुलाया है।" },
  { i: 2, t0: 8.8, t1: 15.2, text: "रविवार से पहले पाँच हज़ार भेज देना, घुटने वाले डॉक्टर के पास जाना है।" },
  { i: 3, t0: 15.2, t1: 21.6, text: "और हाँ, प्रिया का जन्मदिन गुरुवार को है, उसे फ़ोन कर लेना।" },
];

it("extracts, and the gates keep only what the transcript says", async () => {
  const tf = loadTokenFactoryConfig();
  expect(tf, "TOKENFACTORY_API_KEY must be set").not.toBeNull();
  if (!tf) return;
  const call = await extract(tf, { senderLabel: "Maa", noteDate: "2026-10-12 (Monday)", segments: SEGMENTS, openItems: [] });
  expect(call.error).toBeNull();
  const items = call.value?.items ?? [];
  const judged = items.map((item) => {
    const q = quoteGate(item.quote, item.segment, SEGMENTS);
    const f = fieldGate(item, item.quote);
    return { item, quote_gate: q, field_gate: f, due: q.ok ? resolveDue(f.when, "2026-10-12", "2026-10-12") : null };
  });
  writeFileSync(
    path.resolve(__dirname, "../../evidence/tf-extract-smoke.json"),
    JSON.stringify({ at: new Date().toISOString(), model: call.model, request_id: call.requestId, duration_ms: call.durationMs, judged, glosses: call.value?.glosses }, null, 1),
  );
  const money = judged.find((j) => j.item.kind === "money" && j.quote_gate.ok);
  expect(money?.field_gate.amount).toBe(5000);
  expect(money?.due?.due).toBe("2026-10-17");
});
