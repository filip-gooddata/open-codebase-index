#!/usr/bin/env bash
# Builds $OCBI_NOTIFIER_APP (default ~/Applications/Codebase Index.app) from main.swift and signs it ad hoc. macOS registers an
# ad-hoc signed app with notifications switched off and never prompts; allow them once in System
# Settings > Notifications > Codebase Index (style Alerts keeps the action button on screen).
# Rerun after editing main.swift; a rebuild keeps the bundle id, so the setting survives.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="${OCBI_NOTIFIER_APP:-$HOME/Applications/Codebase Index.app}"
OCBI_NOTIFIER_BUNDLE_ID="${OCBI_NOTIFIER_BUNDLE_ID:-io.github.open-codebase-index.notifier}"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
swiftc -O -o "$app/Contents/MacOS/CodebaseIndexNotifier" "$here/main.swift" \
  -framework AppKit -framework UserNotifications
cat >"$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${OCBI_NOTIFIER_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>Codebase Index</string>
  <key>CFBundleDisplayName</key>
  <string>Codebase Index</string>
  <key>CFBundleExecutable</key>
  <string>CodebaseIndexNotifier</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF
codesign --force --sign - "$app"
echo "built $app"
