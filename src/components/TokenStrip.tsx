"use client";

import { useEffect, useRef } from "react";

/**
 * The signature element: what is actually stored. 13 hairline rows (one per NanoCodec codebook) and 12.5 ticks
 * per second (one per frame); each tick's length is its code index / 2016. Drawn from the real .hct, never
 * decoration. Long notes fold several frames into one pixel column (the column shows their largest code).
 */
export function TokenStrip({
  codes,
  seconds,
  playhead,
  onSeek,
  label,
  marks = [],
}: {
  codes: Uint16Array[] | null;
  seconds: number;
  playhead?: number | null;
  onSeek?: (t: number) => void;
  label: string;
  marks?: Array<{ t: number; color?: string }>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      const css = getComputedStyle(canvas);
      const rule = css.getPropertyValue("--rule").trim() || "#b4c4cf";
      const voice = css.getPropertyValue("--voice").trim() || "#2c4a6b";
      const before = css.getPropertyValue("--before").trim() || "#8c9eae";
      const rows = 13;
      const rowH = h / rows;
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = rule;
      for (let r = 0; r < rows; r += 1) {
        ctx.beginPath();
        ctx.moveTo(0, (r + 0.5) * rowH);
        ctx.lineTo(w, (r + 0.5) * rowH);
        ctx.stroke();
      }
      if (!codes || !codes.length) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = before;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(1, 1, w - 2, h - 2);
        ctx.setLineDash([]);
        return;
      }
      const frames = codes[0]?.length ?? 0;
      const cols = Math.max(1, Math.min(frames, Math.floor(w)));
      const per = frames / cols;
      const pitch = w / cols;
      ctx.strokeStyle = voice;
      ctx.lineWidth = Math.max(0.6, pitch * 0.55);
      for (let c = 0; c < cols; c += 1) {
        const f0 = Math.floor(c * per);
        const f1 = Math.max(f0 + 1, Math.floor((c + 1) * per));
        const x = (c + 0.5) * pitch;
        for (let r = 0; r < rows; r += 1) {
          const row = codes[r] as Uint16Array;
          let v = 0;
          for (let f = f0; f < f1; f += 1) v = Math.max(v, row[f] ?? 0);
          const len = Math.max(0.12, v / 2016) * rowH * 0.92;
          const y = (r + 0.5) * rowH;
          ctx.beginPath();
          ctx.moveTo(x, y - len / 2);
          ctx.lineTo(x, y + len / 2);
          ctx.stroke();
        }
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [codes]);

  return (
    <div className="stripwrap">
      <canvas
        ref={ref}
        role="img"
        aria-label={label}
        onClick={(e) => {
          if (!onSeek) return;
          const box = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - box.left) / box.width) * seconds);
        }}
        style={{ cursor: onSeek ? "pointer" : "default" }}
      />
      {marks.map((m, i) => (
        <span key={i} className="playhead" style={{ left: `calc(10px + (100% - 20px) * ${m.t / Math.max(seconds, 0.001)})`, background: m.color ?? "var(--after)", width: 3, opacity: 0.85 }} />
      ))}
      {playhead !== null && playhead !== undefined ? (
        <span className="playhead" style={{ left: `calc(10px + (100% - 20px) * ${Math.min(1, playhead / Math.max(seconds, 0.001))})` }} />
      ) : null}
    </div>
  );
}
