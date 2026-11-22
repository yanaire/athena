#!/bin/sh
set -eu
export LC_ALL=C

if [ "$#" -ne 0 ] || [ "$(/usr/bin/uname -s)" != Darwin ]; then
  printf 'Run sh scripts/inspect-running-desktop.sh inside the macOS session running Athena.\n' >&2
  exit 2
fi

pid=$(/usr/bin/pgrep -x athena-desktop) || {
  printf 'No running Athena desktop process in this macOS instance.\n' >&2
  exit 1
}
case "$pid" in
  ''|*[!0-9]*) printf 'Expected exactly one running Athena desktop process.\n' >&2; exit 1 ;;
esac

exe=$(/bin/ps -ww -p "$pid" -o comm=)
case "$exe" in
  /*.app/Contents/MacOS/athena-desktop) app=${exe%/Contents/MacOS/athena-desktop} ;;
  *) printf 'The desktop process is not running from a macOS app bundle.\n' >&2; exit 1 ;;
esac

node=$(/usr/bin/pgrep -P "$pid" -x athena-node) || {
  printf 'Athena has no running Node child.\n' >&2
  exit 1
}
case "$node" in
  ''|*[!0-9]*) printf 'Expected exactly one Athena Node child.\n' >&2; exit 1 ;;
esac
node_exe=$(/bin/ps -ww -p "$node" -o comm=)
if [ "$node_exe" != "$app/Contents/MacOS/athena-node" ]; then
  printf 'Athena Node is not running from the same bundle.\n' >&2
  exit 1
fi

/usr/bin/codesign --verify --deep --strict "$app"
listeners=$(/usr/sbin/lsof -nP -a -p "$node" -iTCP -sTCP:LISTEN -Fn) || {
  printf 'Could not observe a TCP listener for the bundled Node process.\n' >&2
  exit 1
}
listener=$(printf '%s\n' "$listeners" | /usr/bin/awk '
  /^n/ { count++; if ($0 ~ /^n127[.]0[.]0[.]1:[0-9]+$/) address=substr($0, 2) }
  END { if (count != 1 || !address) exit 1; print address }') || {
  printf 'Expected exactly one Node listener bound to 127.0.0.1.\n' >&2
  exit 1
}

printf 'Athena PID: %s\nBundled Node PID: %s\nNode listener: %s\n' "$pid" "$node" "$listener"
for name in athena-desktop athena-node athena-sandbox; do
  digest=$(/usr/bin/shasum -a 256 < "$app/Contents/MacOS/$name")
  printf '%s SHA-256: %s\n' "$name" "${digest%% *}"
done
if /usr/bin/xattr -p com.apple.quarantine "$app" >/dev/null 2>&1; then
  printf 'App quarantine: present\n'
else
  printf 'App quarantine: not observed\n'
fi
