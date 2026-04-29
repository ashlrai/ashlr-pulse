/**
 * briefing.ts — server-side AI briefing for the dashboard hero.
 *
 * Renders a 2-3 sentence narrative summary of "what happened in the
 * last 24 hours and how does it compare to the prior week" — the kind
 * of thing a CTO would type into Slack at 9am.
 *
 * Inputs are pure aggregates (counts, sums, deltas) — never prompt or
 * completion content. The model sees structured numbers + metadata
 * (repo names, commit subjects from the public github_commit table)
 * and returns plain text.
 *
 * Caching: result is keyed by (user_id, day) and stored in the
 * `dashboard_briefing` table for ~1h. We re-query when stale or when
 * the user hits the "regenerate" button (POST /api/briefing/refresh).
 */

import { sql } from "@/lib/db";
import { complete } from "@/lib/anthropic";
import { fmtUsd, costUsdCents } from "@/lib/pricing";

export interface BriefingInputs {
  /** Last 24h. */
  events: number;
  tokens: number;
  costCents: number | null;
  topRepos: { repo: string; events: number }[];
  topModels: { model: string; tokens: number }[];
  /** Prior 24h-168h baseline (median day across last week). */
  baselineEvents: number;
  baselineTokens: number;
  baselineCostCents: number | null;
  /** Recent commit subjects (capped to 8). */
  commits: string[];
  /** Cofounder activity if peer-share grants exist. */
  peer?: { email: string; events: number; tokens: number; topRepos: string[] };
}

const SYSTEM = `You are Pulse, a concise dashboard narrator for an
agentic-engineering team. You see only aggregate metrics — never user
prompts, completions, or code. Speak in a direct, slightly dry tone
suited for a founder reading at 9am.

Format: 2-3 sentences, plain text, no markdown, no emoji, no headings.
Lead with the most striking change vs the weekly baseline. If activity
is unusually low or high, say so. Mention specific repo names if they
dominate. Mention the cofounder's activity briefly if provided.

Avoid: hedging language ("perhaps", "it seems"), filler ("interestingly"),
generic observations ("you've been busy"). Be specific. Don't recap data
the user already sees in the cards above — instead, surface a take.`.replace(/\s+/g, " ");

export async function generateBriefing(input: BriefingInputs): Promise<string | null> {
  const lines: string[] = [];
  lines.push(`Last 24h: ${input.events} events, ${input.tokens.toLocaleString()} tokens, cost ${fmtUsd(input.costCents ?? null)}.`);
  lines.push(`Weekly baseline (median day): ${input.baselineEvents} events, ${input.baselineTokens.toLocaleString()} tokens, cost ${fmtUsd(input.baselineCostCents ?? null)}.`);
  if (input.topRepos.length) {
    lines.push(`Top repos by event count today: ${input.topRepos.slice(0, 4).map((r) => `${r.repo} (${r.events})`).join(", ")}.`);
  }
  if (input.topModels.length) {
    lines.push(`Model mix (tokens): ${input.topModels.slice(0, 3).map((m) => `${m.model} ${m.tokens.toLocaleString()}`).join(", ")}.`);
  }
  if (input.commits.length) {
    lines.push(`Recent commit subjects: ${input.commits.slice(0, 6).map((c) => `"${c}"`).join("; ")}.`);
  }
  if (input.peer) {
    lines.push(`Peer (${input.peer.email}): ${input.peer.events} events, ${input.peer.tokens.toLocaleString()} tokens, repos: ${input.peer.topRepos.slice(0, 3).join(", ")}.`);
  }

  const user = `Activity briefing input:\n${lines.join("\n")}\n\nWrite the briefing now.`;
  return complete(SYSTEM, user, { temperature: 0.3, maxTokens: 220 });
}

/**
 * Templated fallback when the Anthropic API is unavailable or returns
 * empty. Deterministic, never throws — the dashboard always renders
 * SOMETHING in this slot.
 */
export function templatedBriefing(input: BriefingInputs): string {
  const eventsDelta = input.baselineEvents > 0
    ? input.events / input.baselineEvents - 1
    : 0;
  const direction = Math.abs(eventsDelta) < 0.15
    ? "Activity is in line with your weekly baseline."
    : eventsDelta > 0
      ? `Activity is up ${(eventsDelta * 100).toFixed(0)}% vs the weekly median.`
      : `Activity is down ${(-eventsDelta * 100).toFixed(0)}% vs the weekly median.`;

  const cost = input.costCents != null ? ` Spend ${fmtUsd(input.costCents)}.` : "";
  const topRepo = input.topRepos[0]?.repo;
  const repoLine = topRepo ? ` ${topRepo} dominated.` : "";
  const peerLine = input.peer
    ? ` ${input.peer.email} shipped ${input.peer.events} events.`
    : "";

  return `${direction}${cost}${repoLine}${peerLine}`.trim();
}

/**
 * Loads or computes a cached briefing for (user, day). Cache lives ~1h.
 * Returns null if there's not enough data to write anything meaningful.
 */
export async function getOrComputeBriefing(
  userId: string,
  inputs: BriefingInputs,
): Promise<{ text: string; source: "ai" | "fallback"; generated_at: Date }> {
  const db = sql();
  // Look for a fresh cache entry (< 1h old).
  const cached = await db<{ text: string; source: "ai" | "fallback"; generated_at: Date }[]>`
    SELECT text, source, generated_at
    FROM dashboard_briefing
    WHERE user_id = ${userId}
      AND generated_at >= NOW() - INTERVAL '1 hour'
    ORDER BY generated_at DESC
    LIMIT 1
  `;
  if (cached.length) return cached[0];

  // Generate fresh.
  let text = await generateBriefing(inputs);
  let source: "ai" | "fallback" = "ai";
  if (!text) {
    text = templatedBriefing(inputs);
    source = "fallback";
  }

  // Persist (best-effort — if the table doesn't exist yet, return without writing).
  try {
    await db`
      INSERT INTO dashboard_briefing (user_id, text, source, generated_at)
      VALUES (${userId}, ${text}, ${source}, NOW())
    `;
  } catch {
    // table missing or write failed — still return the value we computed
  }

  return { text, source, generated_at: new Date() };
}

export { costUsdCents };

// ---------------------------------------------------------------------------
// Email-digest briefing helper
// ---------------------------------------------------------------------------

/**
 * Build a one-line briefing from a DigestPayload. Used by the email
 * digest cron to prepend a Claude-written sentence above the data
 * tables. Returns null if there's no useful narrative (empty day) or
 * if the API call fails — callers should treat null as "render without
 * a briefing line."
 */
export async function briefingForDigest(
  payload: import("./digest").DigestPayload,
): Promise<string | null> {
  if (payload.empty) return null;

  const totalEvents = payload.self.bySource.reduce((a, b) => a + b.events, 0);
  const totalTokens = payload.self.bySource.reduce((a, b) => a + b.tokens, 0);
  const totalCents  = payload.self.bySource.reduce((a, b) => a + (b.cents ?? 0), 0);

  // The digest is "yesterday's activity" — we don't have a 7-day baseline
  // available to it without another query, so we use 0 as a sentinel and
  // let the briefing model focus on absolute facts + what dominated.
  const inputs: BriefingInputs = {
    events: totalEvents,
    tokens: totalTokens,
    costCents: totalCents,
    topRepos: payload.self.byRepo.slice(0, 4).map((r) => ({ repo: r.repo, events: r.events })),
    topModels: [],
    baselineEvents: 0,
    baselineTokens: 0,
    baselineCostCents: 0,
    commits: [],
    peer: payload.peers[0]
      ? {
          email: payload.peers[0].owner_email,
          events: payload.peers[0].bySource.reduce((a, b) => a + b.events, 0),
          tokens: payload.peers[0].bySource.reduce((a, b) => a + b.tokens, 0),
          topRepos: (payload.peers[0].byRepo ?? []).slice(0, 3).map((r) => r.repo),
        }
      : undefined,
  };
  const text = await generateBriefing(inputs);
  return text;
}
