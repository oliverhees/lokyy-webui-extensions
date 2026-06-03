#!/bin/sh
# In einem der Container (Pfade gleich). Zeigt cron.jobs-Pfadlogik + wo der neue Mira-Job liegt.
F=$(find / -name jobs.py -path "*/cron/*" 2>/dev/null | grep -v /proc/ | head -1)
echo "jobs.py: $F"
echo "=== Pfad-Aufloesung (Konstanten + getenv/home) ==="
grep -nE "HERMES_DIR|CRON_DIR|JOBS_FILE|OUTPUT_DIR|Path\.home|HERMES_HOME|getenv|environ" "$F" 2>/dev/null | head -25
echo "=== def list_jobs Body ==="
awk '/def list_jobs/{f=1} f{print; n++; if(n>22)exit}' "$F" 2>/dev/null
echo "=== Alle jobs.json + Job-Anzahl + enthaelt Mira-Job a66d21eeaa16? ==="
for j in $(find /home -name jobs.json -path "*cron*" 2>/dev/null); do
  cnt=$(grep -o '"id"' "$j" 2>/dev/null | wc -l)
  echo "$j  (ids: $cnt)"
  grep -q "a66d21eeaa16" "$j" 2>/dev/null && echo "   ^^^ ENTHAELT den neuen Mira-Job"
done
echo "FERTIG"
