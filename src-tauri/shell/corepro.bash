# CorePro shell integration for bash, loaded with --init-file in place of the usual files: load
# those first, then add the marks for CorePro's command blocks.
[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"

if [ -z "$TMUX" ] && [[ "$TERM" != screen* ]] && [ -z "$__corepro_hooked" ]; then
  __corepro_hooked=1
  __corepro_nonce="$COREPRO_NONCE"
  unset COREPRO_NONCE
  __corepro_precmd() {
    local ec=$?
    # D after every command; one with no C before it (an empty line) is ignored by CorePro.
    printf '\e]133;D;%s\a' "$ec"
    printf '\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "$PWD"
    printf '\e]133;A\a'
    return $ec
  }
  __corepro_cmdline() {
    local cmd
    cmd="$(HISTTIMEFORMAT= builtin history 1 | sed 's/^ *[0-9]* *//')"
    cmd="${cmd//\\/\\\\}"
    cmd="${cmd//;/\\x3b}"
    printf '\e]633;E;%s;%s\a\e]133;C\a' "${cmd//$'\n'/\\x0a}" "$__corepro_nonce"
  }
  PROMPT_COMMAND="__corepro_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  PS1="${PS1}\[\e]133;B\a\]"
  # PS0 is printed after a command is read, before it runs (bash 4.4+).
  PS0='$(__corepro_cmdline)'"${PS0}"
fi
