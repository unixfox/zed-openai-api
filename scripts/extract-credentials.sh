#!/usr/bin/env bash
#
# Extract the Zed credentials stored by the Zed desktop app in the OS keyring
# and print them as env lines ready to paste into the server's environment.
#
# Zed's access token is long-lived (there is no refresh flow — Zed only
# re-authenticates when the token is actually invalidated, e.g. you sign out),
# so you extract it ONCE on a machine where Zed desktop is signed in and drop
# the values into your headless server's .env.
#
# Usage:
#   ./scripts/extract-credentials.sh            # prints ZED_USER_ID / ZED_ACCESS_TOKEN
#   ./scripts/extract-credentials.sh --export   # prints `export ...` lines
#   ./scripts/extract-credentials.sh --env-file # append to ./.env
#
set -euo pipefail

MODE="${1:-plain}"

if ! command -v secret-tool >/dev/null 2>&1; then
  echo "error: secret-tool not found. Install it (libsecret-tools / libsecret) and" >&2
  echo "       run this on a machine where the Zed desktop app is signed in." >&2
  exit 1
fi

# secret-tool prints the secret on one stream and attributes on another;
# merge both. --all returns every item matching url=https://zed.dev.
OUTPUT="$(secret-tool search --all --unlock url https://zed.dev 2>&1 || true)"

if [ -z "${OUTPUT//[$'\t\r\n ']/}" ]; then
  echo "error: no Zed credentials found in the keyring." >&2
  echo "       Sign into Zed desktop first, then re-run this script." >&2
  exit 1
fi

# Parse per-item blocks (each starts with a '[/...]' line) so the user id and
# secret we emit belong to the SAME keyring entry, then keep the last (newest)
# block. Falls back gracefully if only one entry exists.
parsed="$(awk '
  /^\[/            { blocks++; uid=""; sec="" }
  /^attribute\.username = / { sub(/^attribute\.username = /, ""); uid=$0 }
  /^secret = /     { sub(/^secret = /, ""); sec=$0 }
  # emit the current block whenever we have both, remembering the last one
  (uid != "" && sec != "") { last_uid=uid; last_sec=sec }
  END {
    print blocks
    print last_uid
    print last_sec
  }
' <<<"$OUTPUT")"

NBLOCKS="$(sed -n '1p' <<<"$parsed")"
USER_ID="$(sed -n '2p' <<<"$parsed")"
ACCESS_TOKEN="$(sed -n '3p' <<<"$parsed")"

if [ -z "$USER_ID" ] || [ -z "$ACCESS_TOKEN" ]; then
  echo "error: found keyring entries but could not extract user id / token." >&2
  exit 1
fi

if [ "${NBLOCKS:-1}" -gt 1 ]; then
  echo "note: found $NBLOCKS zed.dev entries; using the most recent one." >&2
fi

case "$MODE" in
  --export)
    printf "export ZED_USER_ID=%q\n" "$USER_ID"
    printf "export ZED_ACCESS_TOKEN=%q\n" "$ACCESS_TOKEN"
    ;;
  --env-file)
    {
      printf "ZED_USER_ID=%s\n" "$USER_ID"
      printf "ZED_ACCESS_TOKEN='%s'\n" "$ACCESS_TOKEN"
    } >>.env
    echo "appended ZED_USER_ID and ZED_ACCESS_TOKEN to ./.env" >&2
    ;;
  plain | "")
    printf "ZED_USER_ID=%s\n" "$USER_ID"
    printf "ZED_ACCESS_TOKEN='%s'\n" "$ACCESS_TOKEN"
    ;;
  *)
    echo "usage: $0 [--export|--env-file]" >&2
    exit 2
    ;;
esac
