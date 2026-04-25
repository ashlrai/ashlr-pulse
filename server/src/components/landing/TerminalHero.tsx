"use client";

/**
 * TerminalHero.tsx — the centerpiece animation.
 *
 * Renders a "live" terminal that streams Pulse events as if Mason and
 * his cofounder were both pushing commits, ingesting Claude Code spans,
 * and granting peer-share rights in real time. Lines type-on, fade in,
 * and the bottom of the buffer auto-scrolls. A fake blinking caret sits
 * on the most recent line.
 *
 * No JS-heavy graphics — just a stream of styled spans, animated with
 * Framer Motion. Total client JS for this component is ~3kb of TSX +
 * ~50kb of framer-motion (already on the page).
 */

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState } from "react";

type EventKind =
  | "commit"
  | "pr"
  | "review"
  | "claude"
  | "plugin"
  | "share"
  | "system";

interface FakeEvent {
  id: number;
  kind: EventKind;
  ts: string;
  body: string;
}

const SCRIPT: Omit<FakeEvent, "id" | "ts">[] = [
  { kind: "system", body: "$ pulse-agent run --watch ~/code" },
  { kind: "system", body: "[pulse] tailing 25 repos, 1 active claude session" },
  { kind: "claude",  body: "@mason         claude_code  · opus-4-7    · 8.4k tok in / 2.1k out" },
  { kind: "commit",  body: "@mason         ashlrai/pulse              fix(deploy): healthcheck on /login (a3f2e91)" },
  { kind: "claude",  body: "@cofounder     claude_code  · sonnet-4-6  · 1.2k tok in / 480  out" },
  { kind: "commit",  body: "@cofounder     ashlrai/client-acme        feat(api): tenants endpoint    (be77c0d)" },
  { kind: "plugin",  body: "@mason         ashlr_plugin · saved 12,400 tokens via ashlr__grep cache" },
  { kind: "share",   body: "@mason → @cofounder   client-* realtime   { ts, source, repo, tokens_in }" },
  { kind: "pr",      body: "@cofounder     ashlrai/client-acme #141   opened: \"tenants endpoint\"" },
  { kind: "review",  body: "@mason         ashlrai/client-acme #141   approved" },
  { kind: "pr",      body: "@cofounder     ashlrai/client-acme #141   merged" },
  { kind: "commit",  body: "@agent[claude] ashlrai/pulse              chore: bump pino to 9.5.0      (1dc9487)" },
  { kind: "claude",  body: "@mason         claude_code  · opus-4-7    · cycle complete · $0.18" },
  { kind: "system",  body: "[pulse] today: 18 events · 4.2k tokens · $0.34 · 3 PRs · 9 commits" },
];

const KIND_COLORS: Record<EventKind, string> = {
  commit:  "#7CFFA0", // green
  pr:      "#FF60D6", // magenta
  review:  "#FF60D6",
  claude:  "#7CD0FF", // cyan
  plugin:  "#FFE07A", // amber
  share:   "#C99CFF", // purple
  system:  "#666",
};

const KIND_LABEL: Record<EventKind, string> = {
  commit:  "commit",
  pr:      "pr    ",
  review:  "review",
  claude:  "claude",
  plugin:  "plugin",
  share:   "share ",
  system:  "      ",
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function nowFmt(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function TerminalHero(): React.ReactElement {
  const [events, setEvents] = useState<FakeEvent[]>([]);
  const [tick, setTick] = useState(0);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Append the next scripted event every ~700ms, looping forever.
  useEffect(() => {
    const interval = setInterval(() => {
      setEvents((prev) => {
        const next = SCRIPT[prev.length % SCRIPT.length]!;
        const id = ++idRef.current;
        const event: FakeEvent = { id, kind: next.kind, ts: nowFmt(), body: next.body };
        const updated = [...prev, event];
        // Cap at 18 visible lines, drop the head.
        return updated.length > 18 ? updated.slice(updated.length - 18) : updated;
      });
      setTick((t) => t + 1);
    }, 700);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll to bottom whenever a new event lands.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [tick]);

  return (
    <div
      style={{
        position: "relative",
        background: "#0a0a0a",
        border: "1px solid #1f1f1f",
        borderRadius: 10,
        boxShadow:
          "0 0 0 1px rgba(124, 255, 160, 0.05), 0 30px 80px -20px rgba(124, 255, 160, 0.15), 0 10px 30px rgba(0, 0, 0, 0.6)",
        overflow: "hidden",
        height: 460,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <TerminalChrome />
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          padding: "16px 20px",
          fontFamily:
            "ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.85,
          color: "#d8d8d8",
          overflow: "hidden",
        }}
      >
        <AnimatePresence initial={false}>
          {events.map((ev, idx) => {
            const isLast = idx === events.length - 1;
            return (
              <motion.div
                key={ev.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
                style={{ whiteSpace: "pre", display: "flex", gap: 12 }}
              >
                <span style={{ color: "#3a3a3a" }}>{ev.ts}</span>
                <span style={{ color: KIND_COLORS[ev.kind] }}>
                  {KIND_LABEL[ev.kind]}
                </span>
                <span style={{ color: ev.kind === "system" ? "#666" : "#d8d8d8" }}>
                  {ev.body}
                  {isLast && <BlinkingCaret />}
                </span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      <ScanlineOverlay />
    </div>
  );
}

function TerminalChrome(): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 14px",
        background: "linear-gradient(180deg, #1a1a1a 0%, #111 100%)",
        borderBottom: "1px solid #1f1f1f",
      }}
    >
      <span style={dot("#ff5f56")} />
      <span style={dot("#ffbd2e")} />
      <span style={dot("#27c93f")} />
      <span
        style={{
          marginLeft: 12,
          color: "#666",
          fontFamily:
            "ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, monospace",
          fontSize: 11,
          letterSpacing: 0.4,
        }}
      >
        pulse · ~/code
      </span>
    </div>
  );
}

function dot(color: string): React.CSSProperties {
  return {
    width: 11,
    height: 11,
    borderRadius: "50%",
    background: color,
    display: "inline-block",
  };
}

function BlinkingCaret(): React.ReactElement {
  return (
    <motion.span
      animate={{ opacity: [1, 0, 1] }}
      transition={{ duration: 1.0, repeat: Infinity, ease: "linear" }}
      style={{
        display: "inline-block",
        width: 8,
        height: 14,
        marginLeft: 4,
        background: "#7CFFA0",
        verticalAlign: "middle",
      }}
    />
  );
}

function ScanlineOverlay(): React.ReactElement {
  return (
    <div
      aria-hidden
      style={{
        pointerEvents: "none",
        position: "absolute",
        inset: 0,
        background:
          "repeating-linear-gradient(0deg, rgba(255,255,255,0.015) 0px, rgba(255,255,255,0.015) 1px, transparent 1px, transparent 3px)",
        mixBlendMode: "overlay",
      }}
    />
  );
}
