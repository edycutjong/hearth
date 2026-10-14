import { useId } from "react";

/** The violet double-ring date stamp. It appears only on a promise that passed the quote and field gates. */
export function Postmark({ top, bottom, centre, sub, strike = false }: { top: string; bottom: string; centre: string; sub: string; strike?: boolean }) {
  const id = useId().replace(/:/g, "");
  return (
    <div className={`postmark${strike ? " strike" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 120 120">
        <defs>
          <path id={`${id}t`} d="M 18 60 A 42 42 0 0 1 102 60" />
          <path id={`${id}b`} d="M 14 60 A 46 46 0 0 0 106 60" />
        </defs>
        <g fill="none" stroke="var(--after)">
          <circle cx="60" cy="60" r="56" strokeWidth="3" />
          <circle cx="60" cy="60" r="33" strokeWidth="2" />
        </g>
        <text fontFamily="var(--data)" fontWeight="600" fontSize="11" letterSpacing="2" fill="var(--after)">
          <textPath href={`#${id}t`} startOffset="50%" textAnchor="middle">{top}</textPath>
        </text>
        <text fontFamily="var(--data)" fontWeight="600" fontSize="11" letterSpacing="2" fill="var(--after)">
          <textPath href={`#${id}b`} startOffset="50%" textAnchor="middle">{bottom}</textPath>
        </text>
        <text x="60" y="59" textAnchor="middle" fontFamily="var(--display)" fontSize={centre.length > 6 ? 16 : 19} fill="var(--after)">{centre}</text>
        <text x="60" y="78" textAnchor="middle" fontFamily="var(--data)" fontWeight="600" fontSize="10.5" fill="var(--after)">{sub}</text>
        <g stroke="var(--after)" strokeWidth="2.4" opacity="0.85">
          <line x1="-10" y1="44" x2="12" y2="44" />
          <line x1="-10" y1="52" x2="10" y2="52" />
          <line x1="-10" y1="68" x2="10" y2="68" />
          <line x1="-10" y1="76" x2="12" y2="76" />
        </g>
      </svg>
    </div>
  );
}
