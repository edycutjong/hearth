import { describe, expect, it } from "vitest";
import type { ProposedItem } from "@/lib/gates";
import { applyExtraction, emptyMemory, tfAllowed, type TranscriptDoc } from "@/lib/memory";
import type { Extraction, TfCall } from "@/lib/tf";
import { newSpace } from "@/lib/space";

const N1: TranscriptDoc = {
  version: 1, lang: "hi-IN", lang_detected: "hi-IN", duration_s: 47,
  segments: [
    { i: 0, t0: 0, t1: 2.4, text: "बेटा, कैसे हो?" },
    { i: 1, t0: 2.4, t1: 8.8, text: "मेरे घुटने में फिर से दर्द है, डॉक्टर ने सोमवार को बुलाया है।" },
    { i: 2, t0: 8.8, t1: 15.2, text: "रविवार से पहले पाँच हज़ार भेज देना, घुटने वाले डॉक्टर के पास जाना है।" },
  ],
};
const N5: TranscriptDoc = { ...N1, segments: [{ i: 0, t0: 0, t1: 3, text: "पैसे मिल गए बेटा, ख़ुश रहो।" }] };

function item(p: Partial<ProposedItem>): ProposedItem {
  return { kind: "money", who: "Maa", what_en: "send money", quote: "", segment: 0, amount_inr: null, when: null, resolves: null, ...p };
}
function call(items: ProposedItem[], id = "chatcmpl-test"): TfCall<Extraction> {
  return { value: { items, glosses: [{ segment: 0, en: "Son, how are you?" }] }, error: null, requestId: id, model: "nvidia/nemotron-3-super-120b-a12b", durationMs: 4000 };
}
const NOW = new Date("2026-10-12T10:00:00Z");

describe("applyExtraction", () => {
  it("keeps a verbatim ask with its parsed amount and resolved date", () => {
    const m = applyExtraction(emptyMemory(), { id: "n1", anchor: "2026-10-12", label: "Maa" }, N1, call([
      item({ quote: "रविवार से पहले पाँच हज़ार भेज देना", segment: 2, amount_inr: 5000,
        when: { type: "weekday", weekday: "sunday", qualifier: "before", days: null, day_of_month: null, raw: "रविवार से पहले" } }),
    ]), "2026-10-12", NOW);
    expect(m.items).toHaveLength(1);
    expect(m.items[0]).toMatchObject({ amount: 5000, due: "2026-10-17", dueLabel: "before Sunday → Sat 17 Oct", t0: 8.8, t1: 15.2, state: "open" });
    expect(m.stats).toMatchObject({ proposed: 1, kept: 1, droppedByQuoteGate: 0 });
    expect(m.calls[0]?.requestId).toBe("chatcmpl-test");
  });

  it("drops an invented quote and counts it", () => {
    const m = applyExtraction(emptyMemory(), { id: "n1", anchor: "2026-10-12", label: "Maa" }, N1, call([
      item({ quote: "दस हज़ार भेज देना", segment: 2, amount_inr: 10000 }),
    ]), "2026-10-12", NOW);
    expect(m.items).toHaveLength(0);
    expect(m.stats.droppedByQuoteGate).toBe(1);
    expect(m.dropped[0]?.reason).toBe("quote_not_found");
  });

  it("removes an amount the quote does not carry ('amount not stated')", () => {
    const m = applyExtraction(emptyMemory(), { id: "n1", anchor: "2026-10-12", label: "Maa" }, N1, call([
      item({ quote: "घुटने वाले डॉक्टर के पास जाना है", segment: 2, amount_inr: 5000 }),
    ]), "2026-10-12", NOW);
    expect(m.items[0]?.amount).toBeNull();
    expect(m.items[0]?.amountStatus).toBe("removed");
    expect(m.stats.amountRemoved).toBe(1);
  });

  it("marks an earlier money ask received when a later note links it and the amounts agree", () => {
    const first = applyExtraction(emptyMemory(), { id: "n1", anchor: "2026-10-12", label: "Maa" }, N1, call([
      item({ quote: "रविवार से पहले पाँच हज़ार भेज देना", segment: 2, amount_inr: 5000 }),
    ]), "2026-10-12", NOW);
    const target = first.items[0]?.id ?? "";
    const second = applyExtraction(first, { id: "n5", anchor: "2026-10-17", label: "Maa" }, N5, call([
      item({ kind: "other", quote: "पैसे मिल गए बेटा", segment: 0, resolves: target }),
    ]), "2026-10-17", NOW);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.state).toBe("received");
    expect(second.items[0]?.receivedBy?.note).toBe("n5");
    expect(second.stats.resolved).toBe(1);
  });

  it("records a failed call without inventing anything", () => {
    const failed: TfCall<Extraction> = { value: null, error: "Token Factory returned no answer", requestId: null, model: "m", durationMs: 1 };
    const m = applyExtraction(emptyMemory(), { id: "n1", anchor: "2026-10-12", label: "Maa" }, N1, failed, "2026-10-12", NOW);
    expect(m.items).toHaveLength(0);
    expect(m.calls[0]?.error).toMatch(/no answer/);
  });
});

describe("privacy gate for Token Factory", () => {
  it("sends the sample always, a space only with ZDR on or its own opt-in", () => {
    const space = newSpace("UTC");
    expect(tfAllowed(space, true, {})).toBe(true);
    expect(tfAllowed(space, false, {})).toBe(false);
    expect(tfAllowed(space, false, { TF_ZDR_ON: "true" })).toBe(true);
    expect(tfAllowed({ ...space, tfOptIn: { at: "x", textVersion: "v1" } }, false, {})).toBe(true);
  });
});
