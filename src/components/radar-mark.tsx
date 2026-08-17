import { cn } from "@/lib/utils";

export function RadarMark({ className, animate = true }: { className?: string; animate?: boolean }) {
  return (
    <span className={cn("relative inline-flex size-7 items-center justify-center", className)}>
      <svg viewBox="0 0 32 32" className="size-full text-primary" aria-hidden="true">
        <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.35" />
        <circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.25" />
        <circle cx="16" cy="16" r="4" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.2" />
        <g
          style={
            animate ? { transformOrigin: "50% 50%", animation: "radar-sweep 4s linear infinite" } : undefined
          }
        >
          <path d="M16 16 L16 2 A14 14 0 0 1 27 8 Z" fill="currentColor" opacity="0.28" />
          <line x1="16" y1="16" x2="16" y2="2" stroke="currentColor" strokeWidth="1.4" />
        </g>
        <circle cx="22" cy="11" r="1.7" fill="currentColor" />
      </svg>
    </span>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <RadarMark />
      <span className="font-mono text-sm font-semibold tracking-[0.22em] uppercase">Radar</span>
    </span>
  );
}
