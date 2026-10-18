ZDOTDIR="$COREPRO_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
COREPRO_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__corepro_zdotdir"
