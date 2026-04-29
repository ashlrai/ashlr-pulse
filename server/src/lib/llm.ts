/**
 * llm.ts — provider-agnostic single-shot LLM completion.
 *
 * Resolves which provider to call based on env vars, in this order:
 *
 *   1. PULSE_LLM_PROVIDER=openai-compat  → any OpenAI-compatible endpoint
 *      (xAI / Grok, Ollama local, LM Studio, OpenRouter, vLLM …) via
 *      OPENAI_BASE_URL + OPENAI_API_KEY + OPENAI_MODEL.
 *   2. PULSE_LLM_PROVIDER=anthropic      → Anthropic Messages API via
 *      ANTHROPIC_API_KEY.
 *   3. unset (auto): prefer openai-compat if OPENAI_BASE_URL is set,
 *      else openai if OPENAI_API_KEY is set, else anthropic if
 *      ANTHROPIC_API_KEY is set, else null (caller falls back to
 *      templated copy).
 *
 * Examples:
 *   xAI Grok 4:
 *     OPENAI_BASE_URL=https://api.x.ai/v1
 *     OPENAI_API_KEY=xai-…
 *     OPENAI_MODEL=grok-4-1-fast-reasoning
 *
 *   Ollama (local, free):
 *     OPENAI_BASE_URL=http://localhost:11434/v1
 *     OPENAI_API_KEY=ollama  # any non-empty string works
 *     OPENAI_MODEL=qwen2.5-coder:14b
 *
 *   Anthropic:
 *     ANTHROPIC_API_KEY=sk-ant-…
 *     # PULSE_LLM_MODEL=claude-opus-4-7   (optional)
 *
 * Failures degrade gracefully: complete() returns null on any error,
 * never throws. Callers (briefing.ts, ask-pulse.ts) treat null as
 * "no AI available — use the deterministic fallback."
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

type Provider = "anthropic" | "openai-compat";

interface ProviderConfig {
  kind: Provider;
  /** Resolved default model when callers don't specify one. */
  defaultModel: string;
}

let _anthropic: Anthropic | null = null;
let _openai:    OpenAI    | null = null;
let _resolved:  ProviderConfig | null = null;

function resolveProvider(): ProviderConfig | null {
  if (_resolved) return _resolved;

  const explicit = process.env.PULSE_LLM_PROVIDER as Provider | undefined;

  // OpenAI-compatible path. Most flexible — covers xAI, Ollama, LM Studio,
  // OpenRouter, vLLM, Together, and OpenAI proper.
  const oaiKey  = process.env.OPENAI_API_KEY;
  const oaiBase = process.env.OPENAI_BASE_URL;
  const oaiMod  = process.env.OPENAI_MODEL;

  // Anthropic path.
  const antKey  = process.env.ANTHROPIC_API_KEY;
  const antMod  = process.env.PULSE_LLM_MODEL ?? "claude-opus-4-7";

  if (explicit === "openai-compat" && oaiKey) {
    _openai = new OpenAI({ apiKey: oaiKey, baseURL: oaiBase });
    _resolved = { kind: "openai-compat", defaultModel: oaiMod ?? "gpt-4o-mini" };
    return _resolved;
  }
  if (explicit === "anthropic" && antKey) {
    _anthropic = new Anthropic({ apiKey: antKey });
    _resolved = { kind: "anthropic", defaultModel: antMod };
    return _resolved;
  }

  // Auto-detect: prefer openai-compat when a base URL is set (signals
  // the user wants a non-OpenAI host like xAI/Ollama). Otherwise fall
  // through preferring Anthropic (matches the project's prior default).
  if (oaiBase && oaiKey) {
    _openai = new OpenAI({ apiKey: oaiKey, baseURL: oaiBase });
    _resolved = { kind: "openai-compat", defaultModel: oaiMod ?? "gpt-4o-mini" };
    return _resolved;
  }
  if (antKey) {
    _anthropic = new Anthropic({ apiKey: antKey });
    _resolved = { kind: "anthropic", defaultModel: antMod };
    return _resolved;
  }
  if (oaiKey) {
    _openai = new OpenAI({ apiKey: oaiKey, baseURL: oaiBase });
    _resolved = { kind: "openai-compat", defaultModel: oaiMod ?? "gpt-4o-mini" };
    return _resolved;
  }

  return null;
}

export interface CompleteOpts {
  /** Override the resolved default. */
  model?: string;
  /** Defaults to 256 — these are short summaries, not essays. */
  maxTokens?: number;
  /** 0 = deterministic; briefing 0.2-0.3; Ask Pulse 0.0. */
  temperature?: number;
  /** Hint that the response should be a JSON object — strips fences/think
   *  tags before returning. Not enforced (some providers ignore the hint). */
  expectJson?: boolean;
}

/**
 * Single-shot completion. Returns the assistant's concatenated text
 * content, or `null` on any failure (network, missing config, etc.).
 * Never throws.
 */
export async function complete(
  system: string,
  user: string,
  opts: CompleteOpts = {},
): Promise<string | null> {
  const cfg = resolveProvider();
  if (!cfg) return null;

  const model       = opts.model ?? cfg.defaultModel;
  const maxTokens   = opts.maxTokens ?? 256;
  const temperature = opts.temperature ?? 0.2;

  try {
    let raw: string | null = null;

    if (cfg.kind === "anthropic" && _anthropic) {
      const res = await _anthropic.messages.create({
        model, max_tokens: maxTokens, temperature, system,
        messages: [{ role: "user", content: user }],
      });
      raw = res.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("")
        .trim() || null;
    } else if (cfg.kind === "openai-compat" && _openai) {
      const res = await _openai.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: user   },
        ],
        ...(opts.expectJson ? { response_format: { type: "json_object" } } : {}),
      });
      raw = res.choices?.[0]?.message?.content?.trim() ?? null;
    }

    if (!raw) return null;
    return opts.expectJson ? cleanJson(raw) : raw;
  } catch {
    return null;
  }
}

/**
 * Strip markdown fencing and reasoning <think>…</think> blocks so JSON
 * parsing succeeds across reasoning-capable models (Grok, DeepSeek-R1,
 * o1-style). Does nothing destructive — just unwraps obvious wrappers.
 */
function cleanJson(s: string): string {
  let out = s.trim();
  // Strip <think>…</think> blocks (some reasoning models emit these).
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // Strip ```json … ``` fencing.
  const fence = out.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fence) out = fence[1].trim();
  return out;
}

/**
 * Diagnostic — exposed via /api/healthz or admin pages so users can
 * confirm which provider is wired without leaking the API key.
 */
export function llmStatus(): { configured: boolean; provider: Provider | null; model: string | null } {
  const cfg = resolveProvider();
  return cfg
    ? { configured: true, provider: cfg.kind, model: cfg.defaultModel }
    : { configured: false, provider: null, model: null };
}
