"use client";
import { useEffect, useRef, useState } from "react";
import { AGENT_COLOR } from "./types";

export function usePrefersReducedMotion() {
  const [r, setR] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setR(m.matches);
    const f = () => setR(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return r;
}

/** Number that tweens to its new value in ~300ms (instant under reduced motion). */
export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduced || from.current === value) { setShown(value); from.current = value; return; }
    const start = performance.now(), a = from.current, b = value;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 320);
      setShown(Math.round(a + (b - a) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick); else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced]);
  return <span className={className}>{shown}</span>;
}

export function Avatar({ id, size = 28 }: { id: string; size?: number }) {
  const c = AGENT_COLOR[id] ?? "var(--color-sub)";
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, color: c, borderColor: `color-mix(in srgb, ${c} 45%, transparent)`, background: `color-mix(in srgb, ${c} 12%, transparent)`, fontSize: size * 0.42 }}
      className="inline-grid shrink-0 place-items-center rounded-full border font-semibold"
    >
      {id.charAt(0).toUpperCase()}
    </span>
  );
}

export function Badge({ children, tone = "neutral", title }: { children: React.ReactNode; tone?: "neutral" | "ok" | "bad" | "mem" | "warn" | "accent"; title?: string }) {
  const colors: Record<string, string> = {
    neutral: "var(--color-sub)", ok: "var(--color-ok)", bad: "var(--color-bad)", mem: "var(--color-mem)", warn: "var(--color-warn)", accent: "var(--color-accent)",
  };
  const c = colors[tone];
  return (
    <span title={title} className="chip" style={{ color: c, borderColor: `color-mix(in srgb, ${c} 35%, var(--color-line2))`, background: `color-mix(in srgb, ${c} 8%, transparent)` }}>
      {children}
    </span>
  );
}

export function Section({ title, right, children, className = "" }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card flex min-h-0 flex-col ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="eyebrow">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}
