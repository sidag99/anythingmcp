#!/usr/bin/env bash
set -euo pipefail
BASE="${PREVIEWS_BASE:-/home/amcp/previews}"
OUT="$BASE/public/__previews/index.json"
mkdir -p "$(dirname "$OUT")"
{
  printf '{"generatedAt":"%s","entries":[' "$(date -u +%FT%TZ)"
  first=1
  if [[ -f "$BASE/prod.json" ]]; then
    python3 -c 'import json,sys; print(",".join(json.dumps(e) for e in json.load(open(sys.argv[1]))))' "$BASE/prod.json"
    first=0
  fi
  for meta in "$BASE"/instances/*/meta.json; do
    [[ -f "$meta" ]] || continue
    [[ $first -eq 1 ]] || printf ','
    first=0
    cat "$meta"
  done
  printf ']}\n'
} > "$OUT.tmp"
python3 -m json.tool "$OUT.tmp" >/dev/null
mv "$OUT.tmp" "$OUT"
