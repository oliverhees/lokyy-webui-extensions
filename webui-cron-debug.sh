#!/bin/sh
# WICHTIG: im hermes-WEBUI-Container ausfuehren. Definitiver list_jobs-Direkttest.
echo "=== webui-Server-Prozess (welcher User?) ==="
ps -eo user,pid,args 2>/dev/null | grep -iE "webui|server.py|hermes" | grep -v grep | head -5
echo ""
echo "=== cron/jobs.py finden ==="
JP=$(find / -name "jobs.py" -path "*/cron/*" 2>/dev/null | grep -v /proc/ | head -1)
echo "jobs.py: ${JP:-NICHT GEFUNDEN}"
echo ""
echo "=== Python-Direkttest: list_jobs() mit HERMES_HOME=/home/hermeswebui/.hermes ==="
PY=$(command -v python3 || command -v python || echo /usr/bin/python3)
if [ -n "$JP" ]; then
  CRONDIR=$(dirname "$JP"); PP=$(dirname "$CRONDIR")
  HERMES_HOME=/home/hermeswebui/.hermes PYTHONPATH="$PP:$PYTHONPATH" "$PY" -c "
from cron.jobs import list_jobs
j = list_jobs(include_disabled=True)
print('ANZAHL JOBS:', len(j))
for x in j:
    print(' -', (x.get('name') if isinstance(x, dict) else getattr(x,'name','?')))
" 2>&1 | head -25
fi
echo "DEBUG FERTIG"
