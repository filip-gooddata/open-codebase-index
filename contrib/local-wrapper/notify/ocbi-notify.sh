#!/usr/bin/env bash
# Usage: ocbi-notify.sh TITLE BODY [ACTION_LABEL ACTION_COMMAND]
# Posts a desktop notification. ACTION_COMMAND is a shell command the action button runs. Every
# notification is also appended to $OCBI_HOME/logs/notify.log (OCBI_HOME defaults to the
# directory this script is installed in), so nothing is lost on a machine without a desktop.
# macOS: from "Codebase Index.app" (built by notifier/build.sh), which carries the action button.
# Without the app, a plain osascript notification without the button.
# Linux and other systems: notify-send over the session D-Bus (org.freedesktop.Notifications).
# When the notification server supports actions and notify-send has --action (libnotify 0.7.10
# or later), the button is offered and a detached waiter runs the command when it is clicked;
# otherwise the body ends with "Run: ACTION_COMMAND". Without notify-send, a session bus or a
# notification server (a headless machine, an SSH session), it prints the notification and the
# command to stderr. It always exits 0.
set -u
home="${OCBI_HOME:-$(cd "$(dirname "$0")" && pwd)}"
app_name="Codebase index"

# The detached waiter: show the notification with its button and run the command on a click.
if [ "${1:-}" = --wait-action ] && [ $# -eq 5 ]; then
  choice="$(notify-send --app-name="$app_name" --wait --action=run="$4" "$2" "$3" 2>/dev/null)"
  if [ "$choice" = run ]; then
    mkdir -p "$home/logs" 2>/dev/null
    printf '%s action %s: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$4" "$5" >>"$home/logs/notify.log" 2>/dev/null
    bash -c "$5" >>"$home/logs/notify.log" 2>&1 </dev/null
  fi
  exit 0
fi

title="${1:-}" body="${2:-}" action_label="${3:-}" action_command="${4:-}"
[ -n "$action_command" ] || action_label=""
run_hint="${action_command:+ Run: $action_command}"

mkdir -p "$home/logs" 2>/dev/null
printf '%s %s: %s%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$title" "$body" "$run_hint" >>"$home/logs/notify.log" 2>/dev/null

fallback() {
  printf '[ocbi-notify] %s: %s%s\n' "$title" "$body" "$run_hint" >&2
  exit 0
}

if [ "${OCBI_UNAME:-$(uname -s)}" = Darwin ]; then
  app="${OCBI_NOTIFIER_APP:-$HOME/Applications/Codebase Index.app}"
  if [ -d "$app" ]; then
    args=(--title "$title" --body "$body")
    [ -n "$action_command" ] && args+=(--action-label "$action_label" --action-command "$action_command")
    open -g -n "$app" --args "${args[@]}" || fallback
  else
    TITLE="$title" BODY="$body" osascript \
      -e 'display notification (system attribute "BODY") with title "Codebase index" subtitle (system attribute "TITLE")' || fallback
  fi
  exit 0
fi

command -v notify-send >/dev/null 2>&1 || fallback
# A systemd user service or a cron job may not carry the session bus address; the user bus socket
# under XDG_RUNTIME_DIR is the session bus where one exists.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  bus="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus"
  [ -S "$bus" ] || fallback
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$bus"
fi
# A bus without a notification server can leave a D-Bus call waiting; bound every call.
bounded() { if command -v timeout >/dev/null 2>&1; then timeout 15 "$@"; else "$@"; fi; }

# capabilities: the notification server's capability list, empty when it cannot be queried.
capabilities() {
  if command -v gdbus >/dev/null 2>&1; then
    bounded gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications \
      --method org.freedesktop.Notifications.GetCapabilities 2>/dev/null
  elif command -v busctl >/dev/null 2>&1; then
    bounded busctl --user call org.freedesktop.Notifications /org/freedesktop/Notifications \
      org.freedesktop.Notifications GetCapabilities 2>/dev/null
  fi
}

if [ -n "$action_command" ] && capabilities | grep -Eq "['\"]actions['\"]" &&
  notify-send --help 2>&1 | grep -q -- '--action'; then
  # The waiter outlives this script. Inside a systemd unit (INVOCATION_ID is set), a background
  # child would be stopped with the unit, so the waiter gets a transient unit of its own.
  if [ -n "${INVOCATION_ID:-}" ] && command -v systemd-run >/dev/null 2>&1 &&
    systemd-run --user --quiet --collect --setenv=DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
      --setenv=OCBI_HOME="$home" --setenv=PATH="$PATH" -- \
      bash "$0" --wait-action "$title" "$body" "$action_label" "$action_command" >/dev/null 2>&1; then
    exit 0
  fi
  OCBI_HOME="$home" nohup bash "$0" --wait-action "$title" "$body" "$action_label" "$action_command" \
    </dev/null >/dev/null 2>&1 &
  exit 0
fi

bounded notify-send --app-name="$app_name" "$title" "$body$run_hint" >/dev/null 2>&1 || fallback
exit 0
