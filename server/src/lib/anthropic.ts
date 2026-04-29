/**
 * anthropic.ts — server-side Anthropic client wrapper.
 *
 * Used for AI features on the dashboard:
 *   - daily briefing (lib/briefing.ts) — narrative summary of activity
 *   - anomaly summarization (optional)
 *   - "Ask Pulse" (lib/ask-pulse.ts) — NL → chart query
 *
 * Privacy floor still applies. We send numeric aggregates and metadata
 * (repo names, commit messages from GitHub commits) — never user prompt
 * or completion content. The schemas in lib/briefing.ts enforce this.
 *
 * Failures degrade gracefully: callers fall back to deterministic
 * templated copy when the Anthropic API is unavailable.
 */

import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (_client) return _client;
  _client = new Anthropic({ apiKey: key });
  return _client;
}

export interface AskOpts {
  /** Defaults to opus 4.7 for the highest-quality narrative output. */
  model?: string;
  /** Defaults to 256 — these are short summaries, not essays. */
  maxTokens?: number;
  /** Lower = more deterministic. Briefing copy: 0.2; Ask Pulse: 0.0. */
  temperature?: number;
}

/**
 * Fire-and-forget single-shot completion. Returns the assistant's
 * concatenated text content, or `null` on any failure (network, rate
 * limit, missing API key). Does not throw.
 */
export async function complete(
  system: string,
  user: string,
  opts: AskOpts = {},
): Promise<string | null> {
  const client = anthropic();
  if (!client) return null;
  try {
    const res = await client.messages.create({
      model:       opts.model ?? "claude-opus-4-7",
      max_tokens:  opts.maxTokens ?? 256,
      temperature: opts.temperature ?? 0.2,
      system,
      messages:    [{ role: "user", content: user }],
    });
    const out = res.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
    return out || null;
  } catch {
    return null;
  }
}
