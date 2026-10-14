import Link from "next/link";

/** The mark: a short token strip cancelled by a postmark ring. */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 34" aria-hidden="true">
      <g stroke="var(--voice)" strokeWidth="2">
        <line x1="5" y1="9" x2="5" y2="25" />
        <line x1="10" y1="12" x2="10" y2="22" />
        <line x1="15" y1="7" x2="15" y2="27" />
        <line x1="20" y1="13" x2="20" y2="21" />
      </g>
      <circle cx="23" cy="17" r="9" fill="none" stroke="var(--after)" strokeWidth="2.2" />
    </svg>
  );
}

export function TopBar({ current, chip }: { current?: "app" | "judge" | "proof"; chip?: string }) {
  return (
    <header className="topbar">
      <Link className="brand" href="/" aria-label="Hearth home">
        <Mark />
        <span className="word">Hearth</span>
      </Link>
      <nav className="topnav" aria-label="Main">
        <Link href="/" aria-current={current === "app" ? "page" : undefined}>Your notes</Link>
        <Link href="/judge" aria-current={current === "judge" ? "page" : undefined}>Judge sample</Link>
        <Link href="/proof" aria-current={current === "proof" ? "page" : undefined}>Proof</Link>
      </nav>
      {chip ? <span className="chip">{chip}</span> : <span />}
    </header>
  );
}
