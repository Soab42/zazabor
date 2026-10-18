ZDOTDIR="$COREPRO_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
COREPRO_USER_ZDOTDIR="$ZDOTDIR"
# For a login shell .zlogin still follows; otherwise the user's ZDOTDIR is restored now.
[[ -o login ]] && ZDOTDIR="$__corepro_zdotdir" || { ZDOTDIR="$COREPRO_USER_ZDOTDIR"; unset COREPRO_USER_ZDOTDIR __corepro_zdotdir; }

# Marks for CorePro's command blocks (OSC 133 prompt/command/output, 633;E the command line with
# a nonce so output can't fake it, OSC 7 the folder). Off inside tmux/screen, which have their own.
if [[ -z "$TMUX" && "$TERM" != screen* && -z "$__corepro_hooked" ]]; then
  __corepro_hooked=1
  __corepro_nonce="$COREPRO_NONCE"
  unset COREPRO_NONCE
  __corepro_ran=""
  __corepro_precmd() {
    local ec=$?
    [[ -n "$__corepro_ran" ]] && printf '\e]133;D;%s\a' "$ec"
    __corepro_ran=""
    printf '\e]7;file://%s%s\a' "${HOST:-localhost}" "$PWD"
    printf '\e]133;A\a'
    # The end of the prompt; themes rebuild PS1 in their own precmd, so add it back each time.
    [[ "$PS1" == *$'\e]133;B\a'* ]] || PS1="${PS1}%{"$'\e]133;B\a'"%}"
    return $ec
  }
  __corepro_preexec() {
    __corepro_ran=1
    local cmd="${1//\\/\\\\}"
    cmd="${cmd//;/\\x3b}"
    cmd="${cmd//$'\n'/\\x0a}"
    printf '\e]633;E;%s;%s\a' "$cmd" "$__corepro_nonce"
    printf '\e]133;C\a'
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __corepro_precmd
  add-zsh-hook preexec __corepro_preexec
fi
