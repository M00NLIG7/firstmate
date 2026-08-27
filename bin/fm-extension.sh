#!/usr/bin/env bash
# Tracked shell entrypoint for local and fm-on extension binding commands.
set -eu

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
exec "$SCRIPT_DIR/fm-extension.mjs" "$@"
