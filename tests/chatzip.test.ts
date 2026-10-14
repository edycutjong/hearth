import { describe, expect, it } from "vitest";
import { audiosFromEntries, sendersFromChat, uploadsFor } from "@/lib/chatzip";

const ANDROID = [
  "12/10/26, 8:12 pm - Messages and calls are end-to-end encrypted.",
  "12/10/26, 8:14 pm - Maa Ji: PTT-20261012-WA0003.opus (file attached)",
  "12/10/26, 8:15 pm - Maa Ji: रविवार से पहले पैसे भेज देना",
  "13/10/26, 7:02 am - Sunil: PTT-20261013-WA0001.opus (file attached)",
].join("\n");

const IOS = [
  "[12/10/26, 8:14:07 PM] Maa Ji: ‎<attached: 00000012-AUDIO-2026-10-12-20-14-07.opus>",
  "[12/10/26, 8:15:00 PM] Maa Ji: theek hai",
].join("\n");

describe("WhatsApp chat export, parsed in the browser", () => {
  it("maps Android voice notes to their senders", () => {
    const s = sendersFromChat(ANDROID);
    expect(s.get("PTT-20261012-WA0003.opus")).toBe("Maa Ji");
    expect(s.get("PTT-20261013-WA0001.opus")).toBe("Sunil");
  });
  it("maps iOS voice notes to their senders", () => {
    expect(sendersFromChat(IOS).get("00000012-AUDIO-2026-10-12-20-14-07.opus")).toBe("Maa Ji");
  });
  it("dates each note from its own file name", () => {
    const a = audiosFromEntries([{ name: "chat/PTT-20261012-WA0003.opus", size: 9 }, { name: "photo.jpg", size: 1 }], sendersFromChat(ANDROID));
    expect(a).toEqual([{ name: "PTT-20261012-WA0003.opus", anchor: "2026-10-12", sender: "Maa Ji", size: 9 }]);
  });
  it("sends only {name, size, date, label}: never the contact name or the chat text", () => {
    const audios = audiosFromEntries([{ name: "PTT-20261012-WA0003.opus", size: 9 }, { name: "PTT-20261013-WA0001.opus", size: 7 }], sendersFromChat(ANDROID));
    const up = uploadsFor(audios, (s) => (s === "Maa Ji" ? "Maa" : "Me"));
    for (const u of up) expect(Object.keys(u).sort()).toEqual(["anchor", "anchorSource", "label", "name", "size"]);
    const wire = JSON.stringify(up);
    expect(wire).not.toContain("Maa Ji");
    expect(wire).not.toContain("Sunil");
    expect(wire).not.toContain("रविवार");
    expect(up.map((u) => u.label)).toEqual(["Maa", "Me"]);
  });
});
