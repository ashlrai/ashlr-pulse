/**
 * digest-render.ts — turn a DigestPayload into { subject, html, text }.
 *
 * Plain HTML with inline styles. We intentionally avoid React-email or
 * any templating engine — the digest body is small and changes
 * infrequently, and tests are easier when this is a pure function over
 * a typed payload.
 */

import { fmtUsd } from "./pricing";
import type {
  DigestPayload,
  DigestPeer,
  DigestSelfBySource,
  DigestSelfByRepo,
} from "./digest";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const COLORS = {
  bg: "#050505",
  panel: "#0b0b0c",
  rule: "#1f1f22",
  text: "#e8e8e8",
  dim: "#888",
  accent: "#7CFFA0",   // green — main accent
  magenta: "#FF60D6",  // CTA accent
  cyan: "#7CD0FF",     // tools
  amber: "#FFE07A",
};

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
  "https://pulse.ashlr.ai";

/** Optional one-liner narrative summary, prepended above the panels. */
export interface DigestRenderOptions {
  /** Plain-text briefing line. If null/empty, renders nothing. */
  briefing?: string | null;
}

export function renderDigestEmail(
  payload: DigestPayload,
  opts: DigestRenderOptions = {},
): RenderedEmail {
  const subject = subjectFor(payload);
  const text = renderText(payload, opts);
  const html = renderHtml(payload, opts);
  return { subject, html, text };
}

function subjectFor(d: DigestPayload): string {
  if (d.empty) return `pulse · ${d.dateLabel} · quiet day`;
  const totalTokens = d.self.bySource.reduce((s, x) => s + x.tokens, 0);
  const totalCents = d.self.bySource.reduce((s, x) => s + (x.cents ?? 0), 0);
  const peerCount = d.peers.filter((p) => p.bySource.length || (p.byRepo ?? []).length).length;
  const peerTag = peerCount ? ` · +${peerCount} peer${peerCount === 1 ? "" : "s"}` : "";
  return `pulse · ${d.dateLabel} · ${fmtTokens(totalTokens)} tok · ${fmtUsd(totalCents)}${peerTag}`;
}

function fmtTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

function renderText(d: DigestPayload, opts: DigestRenderOptions): string {
  const lines: string[] = [];
  lines.push(`pulse — ${d.dateLabel}`);
  lines.push("");
  if (opts.briefing) {
    lines.push(opts.briefing);
    lines.push("");
  }

  if (d.empty) {
    lines.push("Quiet day. No activity recorded.");
    lines.push("");
    lines.push("If you expected to see something here, check that pulse-agent is running:");
    lines.push("  pulse-agent doctor");
    return lines.join("\n");
  }

  // Headline anomalies — show before everything else so the busy reader
  // catches the signal even if they only skim the first three lines.
  if (d.self.anomalies.length) {
    lines.push("HIGHLIGHTS");
    lines.push("==========");
    for (const a of d.self.anomalies) lines.push(`  · ${a}`);
    lines.push("");
  }

  // Self
  lines.push("YOU");
  lines.push("===");
  if (d.self.bySource.length) {
    lines.push("by tool:");
    for (const r of d.self.bySource) {
      lines.push(`  ${pad(r.source, 12)} ${pad(fmtTokens(r.tokens), 8)} ${fmtUsd(r.cents)}`);
    }
  }
  if (d.self.byProject.length) {
    lines.push("");
    lines.push("by project:");
    for (const p of d.self.byProject) {
      lines.push(`  ${pad(p.project_name, 24)} ${pad(`${p.repos.length} repos`, 10)} ${pad(fmtTokens(p.tokens), 8)} ${fmtUsd(p.cents)}`);
    }
  }
  if (d.self.byRepo.length) {
    lines.push("");
    lines.push("by repo:");
    for (const r of d.self.byRepo.slice(0, 10)) {
      lines.push(`  ${pad(r.repo, 30)} ${pad(fmtTokens(r.tokens), 8)} ${fmtUsd(r.cents)}`);
    }
    if (d.self.byRepo.length > 10) {
      lines.push(`  …and ${d.self.byRepo.length - 10} more`);
    }
  }
  if (d.self.github.commits || d.self.github.prs_opened || d.self.github.prs_merged) {
    lines.push("");
    lines.push(
      `git: ${d.self.github.commits} commits, ${d.self.github.prs_opened} PRs opened, ${d.self.github.prs_merged} merged`,
    );
  }
  if (d.self.missedRepos.length) {
    lines.push("");
    lines.push("⚠ commits but zero token activity (agent not running?):");
    for (const r of d.self.missedRepos) {
      lines.push(`  ${r}`);
    }
  }

  // Peers
  if (d.peers.length) {
    lines.push("");
    lines.push("PEERS");
    lines.push("=====");
    for (const p of d.peers) {
      lines.push("");
      lines.push(p.owner_email);
      if (p.bySource.length) {
        for (const r of p.bySource) {
          lines.push(`  ${pad(r.source, 12)} ${pad(fmtTokens(r.tokens), 8)} ${p.showCost ? fmtUsd(r.cents) : ""}`);
        }
      }
      if (p.byRepo && p.byRepo.length) {
        lines.push("  repos:");
        for (const r of p.byRepo.slice(0, 5)) {
          lines.push(`    ${pad(r.repo, 28)} ${pad(fmtTokens(r.tokens), 8)} ${p.showCost ? fmtUsd(r.cents) : ""}`);
        }
      }
    }
  }

  lines.push("");
  lines.push("---");
  lines.push(`open dashboard: ${APP_URL}/app`);
  lines.push("manage digest preferences: /settings");
  return lines.join("\n");
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function renderHtml(d: DigestPayload, opts: DigestRenderOptions): string {
  const styles = `
    body { background: ${COLORS.bg}; color: ${COLORS.text}; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 24px; }
    .wrap { max-width: 640px; margin: 0 auto; }
    .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
    .brand-name { color: ${COLORS.text}; font-size: 18px; font-weight: 600; letter-spacing: -0.3px; }
    h2 { color: ${COLORS.accent}; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; margin: 24px 0 8px; }
    .date { color: ${COLORS.dim}; font-size: 12px; margin-bottom: 16px; }
    .briefing { background: rgba(124,208,255,0.04); border-left: 2px solid ${COLORS.cyan}; color: ${COLORS.text}; font-size: 13px; line-height: 1.6; padding: 12px 14px; margin: 0 0 24px; border-radius: 4px; }
    .briefing-label { color: ${COLORS.cyan}; font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; display: block; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; color: ${COLORS.dim}; font-weight: 400; padding: 6px 8px; border-bottom: 1px solid ${COLORS.rule}; text-transform: uppercase; letter-spacing: 0.5px; font-size: 10px; }
    td { padding: 6px 8px; border-bottom: 1px solid ${COLORS.rule}; color: ${COLORS.text}; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .panel { background: ${COLORS.panel}; border: 1px solid ${COLORS.rule}; border-radius: 6px; padding: 12px 14px; margin-bottom: 12px; }
    .peer { margin-top: 8px; }
    .peer-email { color: ${COLORS.magenta}; font-size: 11px; margin-bottom: 6px; }
    .warn { color: ${COLORS.amber}; font-size: 11px; margin-top: 12px; }
    .cta { display: inline-block; padding: 10px 18px; background: ${COLORS.magenta}; color: #0a0a0a; border-radius: 6px; font-weight: 500; font-size: 13px; text-decoration: none; }
    .cta-row { text-align: center; margin: 28px 0 12px; }
    .footer { color: ${COLORS.dim}; font-size: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid ${COLORS.rule}; text-align: center; letter-spacing: 0.4px; }
    a { color: ${COLORS.accent}; text-decoration: none; }
  `;

  const head = `<head><meta charset="utf-8"><style>${styles}</style></head>`;
  const header = `
    <div class="brand">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="9" stroke="${COLORS.accent}" stroke-width="1.2" fill="none"/>
        <path d="M11 4 L18 11 L11 18 L4 11 Z" stroke="${COLORS.magenta}" stroke-width="1.2" fill="none"/>
        <circle cx="11" cy="11" r="1.6" fill="${COLORS.accent}"/>
      </svg>
      <span class="brand-name">Pulse</span>
    </div>
    <div class="date">${esc(d.dateLabel)}</div>
  `;

  const briefing = opts.briefing
    ? `<div class="briefing"><span class="briefing-label">briefing · generated by Pulse</span>${esc(opts.briefing)}</div>`
    : "";

  const cta = `
    <div class="cta-row">
      <a class="cta" href="${APP_URL}/app">open dashboard →</a>
    </div>
  `;

  if (d.empty) {
    return `<!doctype html><html>${head}<body><div class="wrap">
      ${header}
      ${briefing}
      <div class="panel">Quiet day. No activity recorded.<br><br>
        If you expected to see something here, run <code>pulse-agent doctor</code> to confirm the agent is running.
      </div>
      ${cta}
      <div class="footer">manage digest preferences at <a href="${APP_URL}/settings">/settings</a></div>
    </div></body></html>`;
  }

  const selfBlock = renderSelfBlockHtml(d);
  const peersBlock = renderPeersBlockHtml(d.peers);

  return `<!doctype html><html>${head}<body><div class="wrap">
    ${header}
    ${briefing}
    ${selfBlock}
    ${peersBlock}
    ${cta}
    <div class="footer">manage digest preferences at <a href="${APP_URL}/settings">/settings</a></div>
  </div></body></html>`;
}

function renderSelfBlockHtml(d: DigestPayload): string {
  const parts: string[] = [];

  // Highlights banner — top of the You section, color-flagged so the
  // reader sees it even mid-scroll.
  if (d.self.anomalies.length) {
    const items = d.self.anomalies.map((a) => `<li>${esc(a)}</li>`).join("");
    parts.push(
      `<div class="panel" style="border-left:3px solid #f0a500;background:#1a1a1a;"><strong style="color:#f0a500;">Highlights</strong><ul style="margin:6px 0 0;padding-left:18px;color:#ddd;line-height:1.5;">${items}</ul></div>`,
    );
  }

  parts.push(`<h2>You</h2>`);

  if (d.self.bySource.length) {
    parts.push(`<div class="panel">${tableBySource(d.self.bySource, true)}</div>`);
  }
  if (d.self.byProject.length) {
    parts.push(`<div class="panel">${tableByProject(d.self.byProject)}</div>`);
  }
  if (d.self.byRepo.length) {
    parts.push(`<div class="panel">${tableByRepo(d.self.byRepo.slice(0, 10), true)}</div>`);
  }
  if (d.self.github.commits || d.self.github.prs_opened || d.self.github.prs_merged) {
    parts.push(`<div class="panel">git · ${d.self.github.commits} commits · ${d.self.github.prs_opened} PRs opened · ${d.self.github.prs_merged} merged</div>`);
  }
  if (d.self.missedRepos.length) {
    parts.push(`<div class="warn">⚠ commits but zero token activity (agent not running?):<br>${d.self.missedRepos.map(esc).join("<br>")}</div>`);
  }
  return parts.join("");
}

function tableByProject(rows: DigestPayload["self"]["byProject"]): string {
  return `<table>
    <thead><tr><th>project</th><th class="num">repos</th><th class="num">events</th><th class="num">tokens</th><th class="num">cost</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.project_name)}</td>
      <td class="num">${r.repos.length}</td>
      <td class="num">${r.events}</td>
      <td class="num">${fmtTokens(r.tokens)}</td>
      <td class="num">${esc(fmtUsd(r.cents))}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function renderPeersBlockHtml(peers: DigestPeer[]): string {
  const visible = peers.filter((p) => p.bySource.length || (p.byRepo ?? []).length);
  if (!visible.length) return "";

  const blocks = visible.map((p) => {
    const sourceTbl = p.bySource.length ? tableBySource(p.bySource, p.showCost) : "";
    const repoTbl = p.byRepo && p.byRepo.length ? tableByRepo(p.byRepo.slice(0, 5), p.showCost) : "";
    return `<div class="panel peer">
      <div class="peer-email">${esc(p.owner_email)}</div>
      ${sourceTbl}
      ${repoTbl}
    </div>`;
  });
  return `<h2>Peers</h2>${blocks.join("")}`;
}

function tableBySource(rows: DigestSelfBySource[], showCost: boolean): string {
  return `<table>
    <thead><tr><th>tool</th><th class="num">events</th><th class="num">tokens</th>${showCost ? '<th class="num">cost</th>' : ""}</tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.source)}</td>
      <td class="num">${r.events}</td>
      <td class="num">${fmtTokens(r.tokens)}</td>
      ${showCost ? `<td class="num">${esc(fmtUsd(r.cents))}</td>` : ""}
    </tr>`).join("")}</tbody>
  </table>`;
}

function tableByRepo(rows: DigestSelfByRepo[], showCost: boolean): string {
  return `<table>
    <thead><tr><th>repo</th><th class="num">events</th><th class="num">tokens</th>${showCost ? '<th class="num">cost</th>' : ""}</tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.repo)}</td>
      <td class="num">${r.events}</td>
      <td class="num">${fmtTokens(r.tokens)}</td>
      ${showCost ? `<td class="num">${esc(fmtUsd(r.cents))}</td>` : ""}
    </tr>`).join("")}</tbody>
  </table>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    if (c === '"') return "&quot;";
    return "&#39;";
  });
}
