# pulse-agent

Local background agent for [Ashlr Pulse](../README.md). Captures Claude Code activity
and git commits, forwards them to the Pulse server via OTLP/HTTP-JSON. Set-and-forget —
no per-shell environment variables required.

## Install

```sh
# From the agent/ directory:
cargo build --release
cp target/release/pulse-agent ~/.local/bin/   # or anywhere on your $PATH
```

## First-time setup

1. Start your Pulse server (see `../QUICKSTART.md`).
2. Mint a PAT:
   ```sh
   cd server && bun run src/cli/mint-pat.ts <your-user-uuid> pulse-agent
   ```
3. Run the login wizard:
   ```sh
   pulse-agent login --url http://localhost:3001
   # Paste the PAT when prompted. Stored in OS keyring — never in shell history.
   ```
4. Edit `~/.config/pulse/config.toml` to add your repos:
   ```toml
   [[repos]]
   path = "/Users/you/code/my-repo"
   ```
5. Verify:
   ```sh
   pulse-agent doctor
   ```

## Running

```sh
# Foreground (Ctrl-C or SIGTERM to stop):
pulse-agent run

# As a launchd service (macOS), add a plist to ~/Library/LaunchAgents/.
# As a systemd user service (Linux), add a .service to ~/.config/systemd/user/.
```

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
| `pulse-agent run` | Foreground watcher. Tails Claude JSONL files in real-time, polls git repos every 60s. |
| `pulse-agent doctor` | Prints config path, PAT source, repo watermarks, then pings ingest. |
| `pulse-agent login --url <url>` | Interactive PAT prompt, stores in keyring, writes stub config. |
| `pulse-agent --version` | Print version. |

## Privacy

- No prompt text, completion text, or file contents are ever read or transmitted.
- Only numeric token counts, model names, timestamps, and git metadata (commit SHA, branch) leave the machine.
- The agent runs as your user — no root, no privileged daemon.
