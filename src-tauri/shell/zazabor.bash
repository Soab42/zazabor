# Zazabor shell integration for bash, loaded with --init-file in place of the usual files: load
# those first, then add the marks for Zazabor's command blocks.
[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"

if [ -z "$TMUX" ] && [[ "$TERM" != screen* ]] && [ -z "$__zazabor_hooked" ]; then
  __zazabor_hooked=1
  __zazabor_nonce="$ZAZABOR_NONCE"
  unset ZAZABOR_NONCE
  __zazabor_precmd() {
    local ec=$?
    # D after every command; one with no C before it (an empty line) is ignored by Zazabor.
    printf '\e]133;D;%s\a' "$ec"
    printf '\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "$PWD"
    printf '\e]133;A\a'
    return $ec
  }
  __zazabor_cmdline() {
    local cmd
    cmd="$(HISTTIMEFORMAT= builtin history 1 | sed 's/^ *[0-9]* *//')"
    cmd="${cmd//\\/\\\\}"
    cmd="${cmd//;/\\x3b}"
    printf '\e]633;E;%s;%s\a\e]133;C\a' "${cmd//$'\n'/\\x0a}" "$__zazabor_nonce"
  }
  PROMPT_COMMAND="__zazabor_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  PS1="${PS1}\[\e]133;B\a\]"
  # PS0 is printed after a command is read, before it runs (bash 4.4+).
  PS0='$(__zazabor_cmdline)'"${PS0}"
fi
