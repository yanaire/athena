#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  printf 'Usage: sh verify-guest-zip.sh /path/to/Athena.zip expected-sha256\n' >&2
  exit 2
fi
zip=$1
expected=$2
case "$expected" in *[!a-f0-9]*|'') exit 2 ;; esac
[ "${#expected}" -eq 64 ] || exit 2
verifier=$(dirname "$0")/check-desktop-bundle.mjs
[ -r "$verifier" ] || { printf 'Missing companion bundle verifier.\n' >&2; exit 1; }

# Check the copy we will extract, even if the read-only share changes on its host.
umask 077
work=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/athena-guest.XXXXXXXX")
trap '/bin/rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
/bin/cp "$zip" "$work/input.zip"
actual=$(/usr/bin/shasum -a 256 < "$work/input.zip")
[ "${actual%% *}" = "$expected" ] || { printf 'ZIP checksum mismatch; nothing extracted.\n' >&2; exit 1; }
/usr/bin/ditto -x -k "$work/input.zip" "$work"
app="$work/Athena.app"
/usr/bin/codesign --verify --deep --strict "$app"
printf 'macOS %s (%s), %s; ZIP SHA-256: %s\n' "$(/usr/bin/sw_vers -productVersion)" "$(/usr/bin/sw_vers -buildVersion)" "$(/usr/bin/uname -m)" "$expected"
"$app/Contents/MacOS/athena-node" "$verifier" --verify-only "$app"
