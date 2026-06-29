"use client";

/**
 * HealthRollup.tsx — Fleet tab card showing per-agent heartbeat status.
 *
 * Polls GET /api/fleet/health-rollup every 5 seconds and renders agent
 * status badges with a last-seen timestamp. Pauses polling when the tab
 * is hidden. Uses framer-motion for smooth badge pulse on status changes.
 *
 * Feature-flagged: only rendered when PULSE_FLEET_HEALTH=true is forwarded
 * to the client as a prop — the server page resolves the env flag.
 *
 * Privacy floor: displays only metadata from the API — agent IDs,
 * heartbeat age, queue depth, and cost aggregates. No code or content.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { palette, space, radius } from "@/lib/theme";

export interface AgentHealthEntry {
  agentId: string;
  lastHeartbeatSec: number;
  isHealthy: boolean;
  proposalQueueDepth: number;
  costLastHour: number;
}

interface HealthRollupResponse {
  agents: AgentHealthEntry[];
}

interface Props {
  /** Forwarded from server: process.env.PULSE_FLEET_HEALTH === "true" */
  enabled: boolean;
}

const REFRESH_MS = 5_000;

function fmtAge(sec: number): string {
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function HealthRollup({ enabled }: Props): ReactElement {
  const [agents, setAgents] = useState<AgentHealthEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await fetch("/api/fleet/health-rollup", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr((body as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      const data: HealthRollupResponse = await res.json();
      setAgents(data.agents ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    poll();

    const schedule = () => {
      timerRef.current = setTimeout(async () => {
        if (!document.hidden) await poll();
        schedule();
      }, REFRESH_MS);
    };
    schedule();

    const onVisibility = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, poll]);

  if (!enabled) {
    return (
      <div style={cardStyle}>
        <CardHeader healthy={0} total={0} />
        <p style={{ fontSize: 13, color: palette.textDim, margin: 0 }}>
          Set <code>PULSE_FLEET_HEALTH=true</code> to enable agent health monitoring.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={cardStyle}>
        <CardHeader healthy={0} total={0} />
        <p style={{ fontSize: 13, color: palette.textDim, margin: 0 }}>Loading…</p>
      </div>
    );
  }

  if (err) {
    return (
      <div style={cardStyle}>
        <CardHeader healthy={0} total={0} />
        <p style={{ fontSize: 13, color: palette.red, margin: 0 }}>Error: {err}</p>
      </div>
    );
  }

  const healthyCount = agents.filter((a) => a.isHealthy).length;

  return (
    <div style={cardStyle}>
      <CardHeader healthy={healthyCount} total={agents.length} />
      {agents.length === 0 ? (
        <p style={{ fontSize: 13, color: palette.textDim, margin: 0 }}>
          No active fleet agents in the last 24 hours.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.x1 }}>
          <AnimatePresence initial={false}>
            {agents.map((agent) => (
              <AgentBadge key={agent.agentId} agent={agent} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CardHeader({ healthy, total }: { healthy: number; total: number }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: space.x2,
      }}
    >
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: palette.text }}>
        Agent Health
      </h3>
      {total > 0 && (
        <span
          style={{
            fontSize: 12,
            color: healthy === total ? palette.green : palette.amber,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {healthy}/{total} healthy
        </span>
      )}
    </div>
  );
}

function AgentBadge({ agent }: { agent: AgentHealthEntry }): ReactElement {
  const dotColor = agent.isHealthy ? palette.green : palette.red;
  const shortId = agent.agentId.length > 12
    ? agent.agentId.slice(0, 8) + "…" + agent.agentId.slice(-4)
    : agent.agentId;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.18 }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.x1,
        padding: `${space.x1}px ${space.x2}px`,
        background: palette.bgRaised,
        borderRadius: radius.md,
        border: `1px solid ${palette.border}`,
      }}
    >
      {/* Animated heartbeat dot */}
      <motion.span
        animate={agent.isHealthy ? { scale: [1, 1.35, 1] } : { scale: 1 }}
        transition={
          agent.isHealthy
            ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" }
            : {}
        }
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dotColor,
          flexShrink: 0,
        }}
      />

      {/* Agent ID */}
      <span
        style={{
          fontSize: 12,
          fontFamily: "monospace",
          color: palette.textDim,
          flexShrink: 0,
          minWidth: 90,
        }}
      >
        {shortId}
      </span>

      {/* Last heartbeat */}
      <span
        style={{
          fontSize: 12,
          color: agent.isHealthy ? palette.text : palette.amber,
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
          minWidth: 60,
        }}
      >
        {fmtAge(agent.lastHeartbeatSec)}
      </span>

      {/* Queue depth badge */}
      {agent.proposalQueueDepth > 0 && (
        <span
          style={{
            fontSize: 11,
            padding: "1px 6px",
            borderRadius: 9999,
            background: palette.amber + "22",
            color: palette.amber,
            flexShrink: 0,
          }}
        >
          {agent.proposalQueueDepth} pending
        </span>
      )}

      {/* Cost last hour */}
      <span
        style={{
          fontSize: 11,
          color: palette.textMute,
          marginLeft: "auto",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {fmtCost(agent.costLastHour)}/hr
      </span>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  background: palette.bgSurface,
  border: `1px solid ${palette.border}`,
  borderRadius: radius.lg,
  padding: space.x4,
};
