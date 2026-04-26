# pulse-hook.bash — bash equivalent of pulse-hook.zsh.
#
# Source from your ~/.bashrc:
#   source ~/.local/share/pulse-agent/pulse-hook.bash
#
# Uses bash's DEBUG trap for preexec semantics and PROMPT_COMMAND chaining
# for precmd. Same privacy floor: only the binary name is captured.

[[ -n "$_PULSE_HOOK_LOADED" ]] && return
_PULSE_HOOK_LOADED=1

PULSE_BUFFER="${PULSE_BUFFER:-$HOME/.local/share/pulse-agent/shell-events.jsonl}"
PULSE_BUFFER_DIR="${PULSE_BUFFER%/*}"
[[ -d "$PULSE_BUFFER_DIR" ]] || mkdir -p "$PULSE_BUFFER_DIR"

_PULSE_RECOGNIZED="claude codex aider sgpt q gemini llm ollama"

_pulse_now_ns() {
  if command -v gdate >/dev/null 2>&1; then
    gdate +%s%N
  elif date +%N 2>/dev/null | grep -qv '%N'; then
    date +%s%N
  else
    # macOS coreutils-free fallback: 1s resolution.
    echo "$(($(date +%s) * 1000000000))"
  fi
}

# Bash's DEBUG trap fires before each command. BASH_COMMAND is only valid
# inside the trap itself (it gets overwritten by any function call), so the
# trap reads BASH_COMMAND once and delegates to _pulse_recognize, which
# accepts the command as an explicit argument and is independently testable.
_pulse_in_prompt=0

_pulse_recognize() {
  # $1 = full command line as seen at trap time
  local first="${1%% *}"
  case "$first" in
    sudo|time|nice|nohup)
      local rest="${1#* }"
      first="${rest%% *}"
      ;;
  esac

  local matched=""
  for c in $_PULSE_RECOGNIZED; do
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

_pulse_debug_trap() {
  if (( _pulse_in_prompt )); then return; fi
  _pulse_recognize "$BASH_COMMAND"
}

_pulse_prompt() {
  local exit_code="$?"
  _pulse_in_prompt=1

  if [[ -n "$_PULSE_CURRENT_CMD" ]]; then
    local end_ns
    end_ns="$(_pulse_now_ns)"
    local cwd="${_PULSE_CURRENT_CWD//\\/\\\\}"
    cwd="${cwd//\"/\\\"}"
    printf '{"ts_start_ns":%s,"ts_end_ns":%s,"cmd":"%s","exit":%d,"cwd":"%s"}\n' \
      "$_PULSE_CURRENT_START" "$end_ns" "$_PULSE_CURRENT_CMD" "$exit_code" "$cwd" \
      >> "$PULSE_BUFFER" 2>/dev/null
    _PULSE_CURRENT_CMD=""
  fi

  _pulse_in_prompt=0
}

trap _pulse_debug_trap DEBUG
# Chain into existing PROMPT_COMMAND if any.
if [[ -n "$PROMPT_COMMAND" ]]; then
  PROMPT_COMMAND="_pulse_prompt;${PROMPT_COMMAND}"
else
  PROMPT_COMMAND="_pulse_prompt"
fi
