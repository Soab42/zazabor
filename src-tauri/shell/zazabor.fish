# Zazabor shell integration for fish (loaded with --init-command after the user's config).
if not set -q TMUX; and not set -q __zazabor_hooked
  set -g __zazabor_hooked 1
  set -g __zazabor_nonce $ZAZABOR_NONCE
  set -e ZAZABOR_NONCE
  function __zazabor_prompt --on-event fish_prompt
    printf '\e]7;file://%s%s\a' (hostname) $PWD
    printf '\e]133;A\a'
  end
  function __zazabor_preexec --on-event fish_preexec
    set -l cmd (string replace -a '\\' '\\\\' -- $argv[1] | string replace -a ';' '\\x3b' | string join '\x0a')
    printf '\e]633;E;%s;%s\a\e]133;C\a' "$cmd" $__zazabor_nonce
  end
  function __zazabor_postexec --on-event fish_postexec
    printf '\e]133;D;%s\a' $status
  end
end
