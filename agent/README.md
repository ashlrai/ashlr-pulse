# pulse-agent

Local background agent for [Ashlr Pulse](../README.md). Captures Claude Code activity
and git commits, forwards them to the Pulse server via OTLP/HTTP-JSON. Set-and-forget —
no per-shell environment variables required.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-pulse/main/agent/install.sh | sh
```

The installer detects your platform (macOS arm64/x86_64, Linux x86_64),
downloads the matching release binary, verifies the sha256, and installs
to `~/.local/bin/pulse-agent`. It also drops the shell-hook scripts into
`~/.local/share/pulse-agent/` so the optional hook below works out of the
box. Re-run any time to upgrade.

### Build from source (development)

```sh
cd agent && cargo build --release
cp target/release/pulse-agent ~/.local/bin/
```

## First-time setup

The recommended flow is `pulse-agent init` — it opens your browser, you
sign in to Pulse and click Approve, and the agent receives a freshly
minted PAT. No ssh, no UUID lookup.

```sh
pulse-agent init --url https://your-pulse-server
```

Then edit `~/.config/pulse/config.toml` to add the local repos you want
git activity ingested for, and verify:

```toml
[[repos]]
path = "/Users/you/code/my-repo"
```

```sh
pulse-agent doctor
```

### Manual PAT (for CI / scripted setups)

If you can't open a browser (CI, headless server), mint a PAT manually
and store it via the legacy login wizard:

```sh
# On the server:
cd server && bun run src/cli/mint-pat.ts <your-user-uuid> pulse-agent

# On the client:
pulse-agent login --url http://localhost:3001
# Paste the PAT when prompted. Stored in OS keyring — never in shell history.
```

## Running

```sh
# Foreground (Ctrl-C or SIGTERM to stop):
pulse-agent run

# As a launchd service (macOS), add a plist to ~/Library/LaunchAgents/.
# As a systemd user service (Linux), add a .service to ~/.config/systemd/user/.
```

The agent tails three sources concurrently:
- **Claude Code** — `~/.claude/projects/*/*.jsonl` (handles cmux: every
  Claude Code instance writes its own session.jsonl, all picked up
  automatically; per-file offsets prevent double-counting).
- **Git** — repos listed in `[[repos]]` in `config.toml`, polled every 60s.
- **Shell** — the buffer at `~/.local/share/pulse-agent/shell-events.jsonl`,
  populated by the optional shell hook (see below). Captures `claude`,
  `codex`, `aider`, `sgpt`, `q`, `gemini`, `llm`, `ollama` invocations.

## Optional: shell hook (capture all terminal AI CLIs)

For users who run AI CLIs (`claude`, `codex`, `aider`, etc.) directly in a
terminal — including from VS Code's integrated terminal or a multiplexer
like cmux — install the shell hook so every invocation gets recorded.

**Privacy floor**: the hook captures **only the binary name**, never argv.
`claude "<prompt>"` records `cmd: "claude"` and discards everything after
the first whitespace token. The Rust agent additionally rejects any record
whose `cmd` contains a space (defense in depth).

### zsh

```sh
mkdir -p ~/.local/share/pulse-agent
cp /path/to/pulse-agent/scripts/pulse-hook.zsh ~/.local/share/pulse-agent/
echo 'source ~/.local/share/pulse-agent/pulse-hook.zsh' >> ~/.zshrc
```

### bash

```sh
mkdir -p ~/.local/share/pulse-agent
cp /path/to/pulse-agent/scripts/pulse-hook.bash ~/.local/share/pulse-agent/
echo 'source ~/.local/share/pulse-agent/pulse-hook.bash' >> ~/.bashrc
```

Open a new terminal — every recognized CLI invocation now appends a JSON
line to `~/.local/share/pulse-agent/shell-events.jsonl`, which the agent
tails and forwards as `source = "shell"` activity events.

To disable without uninstalling, set `[shell].enabled = false` in
`config.toml`.

## Config reference

`~/.config/pulse/config.toml`:

```toml
[server]
url = "http://localhost:3001"
# pat = "pulse_pat_..."  # optional; keyring is preferred

[claude]
# projects_dir = "~/.claude"  # default

[[repos]]
path = "/Users/you/code/repo-a"
# repo_name = "org/repo-a"   # auto-derived from remote.origin.url if omitted

[[repos]]
path = "/Users/you/code/repo-b"
```

## PAT precedence

1. `$PULSE_PAT` environment variable (ephemeral, e.g. CI)
2. `config.server.pat` in config.toml
3. OS keyring (`service=ashlr-pulse, username=<server-url>`)

Never pass the PAT as a CLI flag — it would appear in `ps aux`.

## CLI

| Command | Description |
|---|---|
| `pulse-agent init --url <url>` | Browser-mediated onboarding. Opens the Pulse approval page; on click-Approve, mints a PAT and stores it. **Recommended for new users.** |
| `pulse-agent run` | Foreground watcher. Tails Claude JSONL files in real-time, polls git repos every 60s, tails the optional shell-hook buffer. |
| `pulse-agent doctor` | Prints config path, PAT source, repo watermarks, then pings ingest. |
| `pulse-agent login --url <url>` | Manual PAT prompt; stores in keyring. Use when a browser isn't available (CI, headless). |
| `pulse-agent --version` | Print version. |

## Privacy

- No prompt text, completion text, or file contents are ever read or transmitted.
- Only numeric token counts, model names, timestamps, and git metadata (commit SHA, branch) leave the machine.
- The agent runs as your user — no root, no privileged daemon.
