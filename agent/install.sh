#!/bin/sh
# pulse-agent installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<org>/ashlr-pulse/main/agent/install.sh | sh
#
# Detects the platform, downloads the matching tarball from the latest
# `agent-v*` GitHub Release, verifies the sha256, installs to
# ~/.local/bin/pulse-agent, and prints next steps. Idempotent — re-run
# to upgrade.
#
# Override the source repo by exporting PULSE_REPO=owner/repo.
# Override the target install dir by exporting PULSE_INSTALL_DIR.
# Override the version (default: latest) by exporting PULSE_VERSION
# (e.g. "agent-v0.2.0").

set -e

REPO="${PULSE_REPO:-ashlrai/ashlr-pulse}"
INSTALL_DIR="${PULSE_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${PULSE_VERSION:-latest}"

err() { printf '%s\n' "error: $*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

# ── platform detection ─────────────────────────────────────────────────────

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
  Darwin)
    case "$uname_m" in
      arm64)  asset="pulse-agent-macos-arm64" ;;
      x86_64) asset="pulse-agent-macos-x86_64" ;;
      *) err "unsupported macOS arch: $uname_m" ;;
    esac
    ;;
  Linux)
    case "$uname_m" in
      x86_64)         asset="pulse-agent-linux-x86_64" ;;
      aarch64|arm64)  asset="pulse-agent-linux-arm64"  ;;
      *) err "unsupported Linux arch: $uname_m" ;;
    esac
    ;;
  *) err "unsupported OS: $uname_s (mac/linux only)" ;;
esac

# ── resolve version ────────────────────────────────────────────────────────

if [ "$VERSION" = "latest" ]; then
  log "resolving latest agent release from $REPO..."
  # The /releases/latest endpoint only follows non-prerelease tags. We list
  # tags and pick the first agent-v* one to be tolerant of pre-release
  # tagging schemes.
  if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$@"; }
  elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO- "$@"; }
  else
    err "need curl or wget"
  fi
  api_response="$(fetch "https://api.github.com/repos/$REPO/releases?per_page=20")" \
    || err "failed to query github releases"
  VERSION="$(printf '%s' "$api_response" \
    | grep '"tag_name"' \
    | grep 'agent-v' \
    | head -1 \
    | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
  [ -n "$VERSION" ] || err "no agent-v* release found in $REPO"
  log "latest: $VERSION"
fi

# ── download + verify ──────────────────────────────────────────────────────

base="https://github.com/$REPO/releases/download/$VERSION"
tarball_url="$base/$asset.tar.gz"
sha_url="$base/$asset.tar.gz.sha256"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

log "downloading $asset.tar.gz..."
fetch "$tarball_url"     > "$tmpdir/$asset.tar.gz"      || err "download failed: $tarball_url"
fetch "$sha_url"         > "$tmpdir/$asset.tar.gz.sha256" || err "checksum download failed: $sha_url"

log "verifying sha256..."
expected="$(awk '{print $1}' "$tmpdir/$asset.tar.gz.sha256")"
if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmpdir/$asset.tar.gz" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmpdir/$asset.tar.gz" | awk '{print $1}')"
else
  err "need shasum or sha256sum to verify download"
fi
[ "$expected" = "$actual" ] || err "sha256 mismatch (expected $expected, got $actual)"

# ── unpack + install ───────────────────────────────────────────────────────

log "extracting..."
tar -xzf "$tmpdir/$asset.tar.gz" -C "$tmpdir"

mkdir -p "$INSTALL_DIR"
install_bin="$INSTALL_DIR/pulse-agent"
mv "$tmpdir/pulse-agent" "$install_bin"
chmod 0755 "$install_bin"

# Drop the shell hook scripts into a stable location so the README's
# install commands work as written.
hook_dir="$HOME/.local/share/pulse-agent"
mkdir -p "$hook_dir"
if [ -d "$tmpdir/scripts" ]; then
  cp "$tmpdir/scripts/pulse-hook.zsh"  "$hook_dir/" 2>/dev/null || true
  cp "$tmpdir/scripts/pulse-hook.bash" "$hook_dir/" 2>/dev/null || true
fi

# ── path check + next steps ────────────────────────────────────────────────

log ""
log "installed: $install_bin"
"$install_bin" --version 2>/dev/null || true

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    log ""
    log "warn: $INSTALL_DIR is not on your PATH. add this to your ~/.zshrc or ~/.bashrc:"
    log "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

log ""
log "next step (one command — handles PAT mint, repo discovery, shell hook,"
log "service install, and GitHub connect):"
log "  pulse-agent onboard --url https://pulse.ashlr.ai"
log ""
log "or to drive the steps yourself:"
log "  pulse-agent init --url https://pulse.ashlr.ai   # browser-mediated PAT mint"
log "  pulse-agent doctor                              # validate config + ping ingest"
log "  pulse-agent run                                 # foreground; SIGTERM/Ctrl-C to stop"
log ""
log "the shell hook is installed automatically by 'onboard'. to do it manually:"
log "  echo 'source $hook_dir/pulse-hook.zsh' >> ~/.zshrc    # for zsh"
log "  echo 'source $hook_dir/pulse-hook.bash' >> ~/.bashrc  # for bash"
