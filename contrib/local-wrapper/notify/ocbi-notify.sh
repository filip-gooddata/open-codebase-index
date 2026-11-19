#!/usr/bin/env bash
# Usage: ocbi-notify.sh TITLE BODY [ACTION_LABEL ACTION_COMMAND]
# macOS: posts a notification from "Codebase Index.app" (built by notifier/build.sh), which can
# carry an action button that runs ACTION_COMMAND through the shell. Without the app it falls
# back to a plain osascript notification, without the button.
# Linux: notify-send when available (no button). Elsewhere it prints to stderr.
title="$1" body="$2"
app="${OCBI_NOTIFIER_APP:-$HOME/Applications/Codebase Index.app}"

if [ "$(uname -s)" = Darwin ]; then
  if [ -d "$app" ]; then
    args=(--title "$title" --body "$body")
    [ $# -ge 4 ] && args+=(--action-label "$3" --action-command "$4")
    open -g -n "$app" --args "${args[@]}"
  else
    TITLE="$title" BODY="$body" osascript \
      -e 'display notification (system attribute "BODY") with title "Codebase index" subtitle (system attribute "TITLE")'
  fi
elif command -v notify-send >/dev/null 2>&1; then
  notify-send "Codebase index: $title" "$body${4:+ ($3: $4)}"
else
  printf '[ocbi-notify] %s: %s%s\n' "$title" "$body" "${4:+ ($3: $4)}" >&2
fi
