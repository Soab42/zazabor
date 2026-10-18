# CorePro shell integration. ZDOTDIR points here so these files load first; each one sources the
# user's own file of the same name from their real ZDOTDIR, then points ZDOTDIR back here for the
# next stage. Nothing in the user's files is changed.
__corepro_zdotdir="$ZDOTDIR"
ZDOTDIR="${COREPRO_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
COREPRO_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__corepro_zdotdir"
