#!/usr/bin/env bash
# Claude Code PostToolUse hook target.
# Reads the hook payload on stdin and reindexes when the written file is under
# one of the roots. Configured through the same env variables as the indexer:
# MDMEM_ROOTS (comma-separated directories, required) and MDMEM_DB (optional).
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[ -n "$file" ] || exit 0

# Without MDMEM_ROOTS, fall back to the config written by `mdmem init`. The
# filter list comes from config.json; the indexer itself resolves the same
# config, so no env overrides are passed in that mode.
filter=$MDMEM_ROOTS
if [ -z "$filter" ]; then
  config="${MDMEM_HOME:-$HOME/.mdmem}/config.json"
  [ -f "$config" ] || exit 0
  filter=$(jq -r '([.store] + (.roots // [])) | join(",")' "$config")
fi
[ -n "$filter" ] || exit 0

IFS=',' read -ra roots <<< "$filter"
for root in "${roots[@]}"; do
  root=${root/#\~/$HOME}
  case "$file" in
    "$root"/*)
      exec node "$(dirname "$0")/../src/indexer.ts" >/dev/null 2>&1
      ;;
  esac
done
exit 0
