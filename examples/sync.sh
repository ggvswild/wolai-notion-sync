#!/bin/sh
set -eu
SYNC_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SYNC_SCRIPT_DIR/.."
: "${WOLAI_MCP_TOKEN:?Set WOLAI_MCP_TOKEN in a private environment}"
: "${NOTION_TOKEN:?Set NOTION_TOKEN in a private environment}"
exec node bin/cli.mjs sync --apply --data-dir "${SYNC_DATA_DIR:-.wolai-notion-sync}"
