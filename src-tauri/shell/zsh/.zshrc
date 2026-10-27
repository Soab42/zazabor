ZDOTDIR="$ZAZABOR_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
ZAZABOR_USER_ZDOTDIR="$ZDOTDIR"
# For a login shell .zlogin still follows; otherwise the user's ZDOTDIR is restored now.
[[ -o login ]] && ZDOTDIR="$__zazabor_zdotdir" || { ZDOTDIR="$ZAZABOR_USER_ZDOTDIR"; unset ZAZABOR_USER_ZDOTDIR __zazabor_zdotdir; }

# Marks for Zazabor's command blocks (OSC 133 prompt/command/output, 633;E the command line with
# a nonce so output can't fake it, OSC 7 the folder). Off inside tmux/screen, which have their own.
if [[ -z "$TMUX" && "$TERM" != screen* && -z "$__zazabor_hooked" ]]; then
  __zazabor_hooked=1
  __zazabor_nonce="$ZAZABOR_NONCE"
  unset ZAZABOR_NONCE
  __zazabor_ran=""
  __zazabor_precmd() {
    local ec=$?
    [[ -n "$__zazabor_ran" ]] && printf '\e]133;D;%s\a' "$ec"
    __zazabor_ran=""
    printf '\e]7;file://%s%s\a' "${HOST:-localhost}" "$PWD"
    printf '\e]133;A\a'
    # The end of the prompt; themes rebuild PS1 in their own precmd, so add it back each time.
    [[ "$PS1" == *$'\e]133;B\a'* ]] || PS1="${PS1}%{"$'\e]133;B\a'"%}"
    return $ec
  }
  __zazabor_preexec() {
    __zazabor_ran=1
    local cmd="${1//\\/\\\\}"
    cmd="${cmd//;/\\x3b}"
    cmd="${cmd//$'\n'/\\x0a}"
    printf '\e]633;E;%s;%s\a' "$cmd" "$__zazabor_nonce"
    printf '\e]133;C\a'
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __zazabor_precmd
  add-zsh-hook preexec __zazabor_preexec
fi
