# pulse-hook.zsh — capture AI-CLI invocations into pulse-agent's buffer.
#
# Source from your ~/.zshrc:
#   source ~/.local/share/pulse-agent/pulse-hook.zsh
#
# Captures only the BINARY NAME — never the args. `claude "<prompt>"` would
# put the prompt on the command line, so we deliberately discard everything
# after the first whitespace token. The Rust agent additionally rejects any
# record whose "cmd" field contains a space (defense in depth).
#
# Recognized CLIs (others are silently skipped):
#   claude codex aider sgpt q gemini llm ollama
#
# Output: one JSON line per recognized invocation, appended to
# ~/.local/share/pulse-agent/shell-events.jsonl

# Idempotency — don't double-register if already sourced.
[[ -n "$_PULSE_HOOK_LOADED" ]] && return
_PULSE_HOOK_LOADED=1

PULSE_BUFFER="${PULSE_BUFFER:-$HOME/.local/share/pulse-agent/shell-events.jsonl}"
PULSE_BUFFER_DIR="${PULSE_BUFFER%/*}"
[[ -d "$PULSE_BUFFER_DIR" ]] || mkdir -p "$PULSE_BUFFER_DIR"

# Whitespace-separated allow-list. Update RECOGNIZED_CLIS in agent/src/shell.rs
# at the same time — the Rust side is the source of truth, but trimming here
# keeps the buffer file small.
_PULSE_RECOGNIZED=("claude" "codex" "aider" "sgpt" "q" "gemini" "llm" "ollama")

_pulse_now_ns() {
  # zsh exposes $EPOCHREALTIME (seconds.fraction) via zsh/datetime.
  zmodload zsh/datetime 2>/dev/null
  if [[ -n "$EPOCHREALTIME" ]]; then
    # multiply by 1e9; zsh integer math is fine
    local sec="${EPOCHREALTIME%.*}"
    local frac="${EPOCHREALTIME#*.}"
    # pad / truncate frac to 9 digits
    frac="${frac}000000000"
    frac="${frac:0:9}"
    print -- "${sec}${frac}"
  else
    # Fallback: 1s resolution
    print -- "$(($(date +%s) * 1000000000))"
  fi
}

_pulse_preexec() {
  # $1 is the command line as the user typed it (post-alias, pre-eval).
  # First word after stripping leading whitespace is the binary.
  local first="${${1## }%% *}"
  # Strip a leading sudo / time / nice etc.
  case "$first" in
    sudo|time|nice|nohup) first="${${1#* }## }"; first="${first%% *}" ;;
  esac

  # Match against recognized list.
  local matched=""
  for c in "${_PULSE_RECOGNIZED[@]}"; do
    if [[ "$first" == "$c" ]]; then matched="$c"; break; fi
  done
  if [[ -z "$matched" ]]; then
    _PULSE_CURRENT_CMD=""
    return
  fi

  _PULSE_CURRENT_CMD="$matched"
  _PULSE_CURRENT_START="$(_pulse_now_ns)"
  _PULSE_CURRENT_CWD="$PWD"
}

_pulse_precmd() {
  local exit_code="$?"
  if [[ -z "$_PULSE_CURRENT_CMD" ]]; then return; fi

  local end_ns
  end_ns="$(_pulse_now_ns)"

  # Single-line JSON. Escape backslashes and quotes in cwd.
  local cwd="${_PULSE_CURRENT_CWD//\\/\\\\}"
  cwd="${cwd//\"/\\\"}"

  printf '{"ts_start_ns":%s,"ts_end_ns":%s,"cmd":"%s","exit":%d,"cwd":"%s"}\n' \
    "$_PULSE_CURRENT_START" "$end_ns" "$_PULSE_CURRENT_CMD" "$exit_code" "$cwd" \
    >> "$PULSE_BUFFER" 2>/dev/null

  _PULSE_CURRENT_CMD=""
  _PULSE_CURRENT_START=""
  _PULSE_CURRENT_CWD=""
}

# Register hooks idempotently.
autoload -Uz add-zsh-hook 2>/dev/null
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook preexec _pulse_preexec
  add-zsh-hook precmd  _pulse_precmd
else
  # Fallback: chain via wrapper functions.
  preexec() { _pulse_preexec "$@"; }
  precmd()  { _pulse_precmd; }
fi
