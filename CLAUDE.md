# CLAUDE.md

This file is read natively by Claude Code. The canonical instructions
live in [AGENTS.md](./AGENTS.md) — the 2026 cross-tool standard, also
read by Codex, Cursor, Aider, Gemini CLI, Windsurf, and others.

@AGENTS.md

## Claude Code-specific notes

- **Memory files** for this project live at
  `~/.claude/projects/-Users-masonwyatt-Desktop-ashlr-pulse/memory/`.
  Build them up over time per the `auto memory` instructions in the
  user's global CLAUDE.md.
- **Skills** live under `.claude/skills/` if/when added.
- **Hooks** live in `.claude/settings.json` if/when added — currently
  none. Add via the `/update-config` skill if needed.
- **Plan mode**: when the user asks for non-trivial work, use the
  `/deep-work` skill (already invoked once for the AGENTS.md design).
  Architectural questions get full Phase 2 exploration.
- **Bash hooks**: when running shell commands in this repo, prefer the
  `ashlr__bash` MCP tool over the built-in Bash tool — it auto-compresses
  verbose output (the project's MCP server documents this).
