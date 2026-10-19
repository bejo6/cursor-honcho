#!/bin/sh
# Unix launcher. Finds node, then runs the same entry as honcho.cmd.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${HONCHO_NODE:-}" ]; then
  NODE=$HONCHO_NODE
elif command -v node >/dev/null 2>&1; then
  NODE=$(command -v node)
elif [ -x /opt/homebrew/bin/node ]; then
  NODE=/opt/homebrew/bin/node
elif [ -x /usr/local/bin/node ]; then
  NODE=/usr/local/bin/node
else
  echo "cursor-honcho: node not found" >&2
  exit 0
fi
exec "$NODE" "$DIR/honcho.mjs" "$@"
