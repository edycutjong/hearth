import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addDays, anchorFromFilename, resolveDue, shortDate } from "@/lib/dates";
import { verifyWhen, type ProposedWhen } from "@/lib/gates";

interface Case {
  anchor: string;
  today: string;
  phrase: string;
  when: ProposedWhen | null;
  due: string | null;
  status: string;
}

function loadCases(): Case[] {
  const file = path.resolve(__dirname, "fixtures/dates.csv");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((line) => {
      const [anchor, today, phrase, type, weekday, qualifier, days, dom, due, status] = line.split(",");
      const when: ProposedWhen | null =
        type === "none"
          ? { type: "none" }
          : {
              type: type as ProposedWhen["type"],
              weekday: weekday || null,
              qualifier: qualifier || null,
              days: days ? Number(days) : null,
              day_of_month: dom ? Number(dom) : null,
              raw: phrase ?? "",
            };
      return { anchor: anchor ?? "", today: today ?? "", phrase: phrase ?? "", when, due: due || null, status: status ?? "" };
    });
}

const cases = loadCases();

describe("date resolver over the fixture table (field gate + resolver, end to end)", () => {
  it("has at least 30 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(cases.map((c) => [c.phrase, c] as const))("%s", (_phrase, c) => {
    const verified = verifyWhen(c.when, c.phrase);
    const r = resolveDue(verified.when, c.anchor, c.today);
    expect(r.status).toBe(c.status);
    expect(r.due).toBe(c.status === "unclear" ? null : c.due);
  });
});

describe("resolver details", () => {
  it("labels a 'before' due date so the stamp and the calendar agree", () => {
    const r = resolveDue({ type: "weekday", weekday: 0, qualifier: "before", raw: "" }, "2026-10-12", "2026-10-12");
    expect(r.label).toBe("before Sunday → Sat 17 Oct");
  });

  it("never turns a due date before the anchor into a reminder", () => {
    // A day-of-month already gone in the anchor's month rolls forward, never back.
    const r = resolveDue({ type: "day_of_month", day: 1, raw: "" }, "2026-10-12", "2026-10-12");
    expect(r.due).toBe("2026-11-01");
  });

  it("formats short dates and adds days across a month end", () => {
    expect(shortDate("2026-10-17")).toBe("Sat 17 Oct");
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });

  it("reads anchors from WhatsApp export file names (Android and iOS)", () => {
    expect(anchorFromFilename("PTT-20261012-WA0003.opus")).toBe("2026-10-12");
    expect(anchorFromFilename("00000012-AUDIO-2026-10-19-09-41-07.opus")).toBe("2026-10-19");
    expect(anchorFromFilename("voice note.m4a")).toBeNull();
    expect(anchorFromFilename("PTT-20261332-WA0003.opus")).toBeNull();
  });
});
