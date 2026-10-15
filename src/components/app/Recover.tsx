"use client";

import { useState } from "react";
import { api } from "./types";

/** Open a kept space on this device with its recovery key (shown once, when the space was kept). */
export function Recover() {
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="stack">
      <form
        style={{ display: "flex", gap: 8 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!key.trim()) {
            setMsg("Paste the recovery key first.");
            return;
          }
          const r = await api<{ ok?: boolean; error?: string }>("/api/space/recover", { method: "POST", body: JSON.stringify({ key: key.trim() }) });
          setMsg(r.ok ? "Opened. Reloading…" : (r.data.error ?? "That key does not open a space."));
          if (r.ok) window.location.reload();
        }}
      >
        <input type="text" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Recovery key from another device" aria-label="Recovery key" />
        <button className="btn">Open</button>
      </form>
      {msg ? <p className="note-hint" role="status">{msg}</p> : null}
    </div>
  );
}
