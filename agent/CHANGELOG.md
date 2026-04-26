# Changelog — pulse-agent

## 0.3.0 — 2026-04-25 (in progress)

- **`pulse-agent init` subcommand** — browser-mediated onboarding.
  `pulse-agent init --url https://your-pulse-server` prints a code,
  opens the approval page, and polls until you click Approve in your
  authenticated browser session. Replaces the awkward
  `bun run mint-pat.ts <user_uuid> <name>` flow that required ssh
  access to the server.
- **Correct cmux timestamps** — Claude Code session lines are now
  stamped with the JSONL line's `timestamp` field, not the agent's
  scan-time clock. Per-hour dashboard aggregations are accurate again
  for users running many concurrent Claude Code instances.
- **Authoritative session id + git branch** — preferred from the JSONL
  fields when present (`sessionId`, `gitBranch`); falls back to the old
  filename / libgit2 derivations.

## 0.2.0 — 2026-04-25

- **Shell-hook ingester** — new tailer for `~/.local/share/pulse-agent/shell-events.jsonl`,
  populated by the `scripts/pulse-hook.zsh` and `scripts/pulse-hook.bash`
  scripts. Captures every recognized terminal AI CLI invocation
  (`claude`, `codex`, `aider`, `sgpt`, `q`, `gemini`, `llm`, `ollama`)
  with cwd, exit code, and duration. Hard privacy floor: only the binary
  name leaves the shell — never argv. Defense in depth on the Rust side
  rejects any record whose `cmd` contains shell metachars.
- **Distribution** — `install.sh` one-liner + GitHub Releases workflow
  cross-compiling for macOS arm64/x86_64 + Linux x86_64. Replaces the
  old `cargo build --release` install path.
- **CI** — agent crate now built and tested in GitHub Actions; shell-hook
  smoke tests run for both zsh and bash.
- **Cmux compatibility verified** — the existing recursive watcher on
  `~/.claude/projects/*/*.jsonl` already handles many concurrent Claude
  Code sessions; per-file offsets prevent double-counting. No code change
  needed, but documented.

## 0.1.0 — 2026-04-21

- Initial release. Tails Claude Code session JSONL files in real time;
  polls configured git repos every 60s; emits OTLP/HTTP-JSON spans to a
  Pulse server with PAT auth. CLI subcommands: `run`, `doctor`, `login`.
