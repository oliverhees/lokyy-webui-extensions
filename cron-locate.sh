#!/bin/sh
# Im hermes-agent-Container. Findet die cron jobs.json relativ zu HERMES_HOME.
echo "=== HERMES_HOME = ${HERMES_HOME:-<unset>} ==="
echo "=== jobs.json-Dateien unter HERMES_HOME ==="
find "${HERMES_HOME:-/home/hermes/.hermes}" -name "jobs.json" 2>/dev/null
echo "=== alle cron-bezogenen JSON ==="
find "${HERMES_HOME:-/home/hermes/.hermes}" -path "*cron*" 2>/dev/null | head -20
echo "=== Job-Namen in den gefundenen jobs.json ==="
for f in $(find "${HERMES_HOME:-/home/hermes/.hermes}" -name "jobs.json" 2>/dev/null); do
  echo "## $f"; grep -o '"name":[^,}]*' "$f" 2>/dev/null
done
echo "LOCATE FERTIG"
