"use client";

import type { MemoryItem } from "@/lib/memory";
import { Postmark } from "./Postmark";
import { inr, mmss, shortDay } from "./format";

const KIND: Record<string, string> = {
  money: "Money ask",
  call: "Call",
  visit: "Visit",
  health: "Health · quoted, never interpreted",
  other: "Reminder",
};

/**
 * A kept promise as a money-order coupon: AMOUNT / FOR / BY / IN THEIR WORDS. The violet postmark is struck
 * only when the item passed the quote gate AND has a date the resolver could compute.
 */
export function Coupon({
  item,
  gloss,
  onPlay,
  calendarHref,
  strike = false,
}: {
  item: MemoryItem;
  gloss?: string;
  onPlay?: (t0: number, t1: number) => void;
  calendarHref?: string | null;
  strike?: boolean;
}) {
  const dated = item.due !== null && item.dueStatus !== "unclear";
  const stamped = dated && item.state === "open";
  const cls = ["coupon", !dated ? "unclear" : "", item.state === "received" ? "received" : ""].filter(Boolean).join(" ");
  const qualifier = item.dueLabel.split(" → ")[0]?.toUpperCase() ?? "";
  return (
    <article className={cls} aria-label={`${KIND[item.kind] ?? "Reminder"}: ${item.what_en}`}>
      <div className="kind">
        {KIND[item.kind] ?? "Reminder"} · {item.who}
      </div>
      {item.kind === "money" ? (
        <div className="row">
          <span className="lab">Amount</span>
          <span className={item.amount !== null ? "val big" : "val muted"}>{item.amount !== null ? inr(item.amount) : "amount not stated"}</span>
        </div>
      ) : null}
      <div className="row">
        <span className="lab">For</span>
        <span className="val">{item.what_en}</span>
      </div>
      <div className="row">
        <span className="lab">By</span>
        <span className="val">
          {dated ? item.dueLabel : <>date unclear{item.whenRaw ? <> · «{item.whenRaw}»</> : null}</>}
          {item.state === "received" ? <span className="muted"> · received ({shortDay(item.receivedBy?.at.slice(0, 10) ?? item.created.slice(0, 10))})</span> : null}
        </span>
      </div>
      <div className="row">
        <span className="lab">In their words</span>
        <span>
          <span className="words" lang="hi">«{item.quote}»</span>
          <br />
          <span className="gloss">
            as transcribed · {mmss(item.t0)}
            {item.amountStatus === "verified" ? " · amount parsed by code from the quote" : item.amountStatus === "removed" ? " · the model's amount was not in the quote, so it was removed" : ""}
            {item.whenStatus === "verified" ? " · date resolved by code from the quote and the note's own date" : item.whenStatus === "removed" ? " · the model's date was not in the quote, so it was removed" : ""}
          </span>
          {gloss ? (
            <>
              <br />
              <span className="gloss">Machine translation of the segment: {gloss}</span>
            </>
          ) : null}
          {item.state === "received" && item.receivedBy ? (
            <>
              <br />
              <span className="gloss" lang="hi">Received: «{item.receivedBy.quote}»</span>
            </>
          ) : null}
        </span>
      </div>
      <div className="acts">
        {onPlay ? (
          <button className="btn small" onClick={() => onPlay(item.t0, item.t1)} aria-label={`Play the words at ${mmss(item.t0)}`}>
            ▶ {mmss(item.t0)}
          </button>
        ) : null}
        {calendarHref && stamped && item.dueStatus !== "passed" ? (
          <a className="btn small kept" href={calendarHref} target="_blank" rel="noreferrer">
            + Calendar
          </a>
        ) : null}
      </div>
      {stamped ? (
        <Postmark
          top={qualifier.slice(0, 18)}
          bottom={item.due ? shortDay(item.due).toUpperCase() : ""}
          centre={item.kind === "money" && item.amount !== null ? inr(item.amount) : item.kind.toUpperCase()}
          sub="KEPT"
          strike={strike}
        />
      ) : null}
    </article>
  );
}
