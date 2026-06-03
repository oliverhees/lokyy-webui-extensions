#!/bin/sh
# WICHTIG: im hermes-WEBUI-Container. Findet das venv-Python (mit yaml) und testet list_jobs direkt.
AGENTSRC=/home/hermeswebui/.hermes/hermes-agent
echo "=== Python mit yaml finden ==="
PY=""
for cand in $(find / \( -name python3 -o -name python \) -type f 2>/dev/null | grep -vE "/proc/|/home/hermeswebui/.hermes/hermes-agent" | sort -u); do
  if "$cand" -c "import yaml" 2>/dev/null; then PY="$cand"; echo "OK (yaml): $cand"; break; fi
done
if [ -z "$PY" ]; then
  echo "kein python mit yaml ueber find -> suche venv-Verzeichnisse"
  find / -name "activate" -path "*venv*" 2>/dev/null | grep -v /proc/ | head
  exit 0
fi
echo ""
echo "=== list_jobs() Direkttest (HERMES_HOME=/home/hermeswebui/.hermes) ==="
HERMES_HOME=/home/hermeswebui/.hermes PYTHONPATH="$AGENTSRC:$PYTHONPATH" "$PY" -c "
import os
print('HERMES_HOME(env):', os.environ.get('HERMES_HOME'))
from cron import jobs as J
print('jobs.py-Pfadkonstanten:', [a for a in dir(J) if 'PATH' in a.upper() or 'HOME' in a.upper() or 'JOBS' in a.upper()][:10])
for a in dir(J):
    if 'PATH' in a.upper() or ('HOME' in a.upper()):
        try: print('  ', a, '=', getattr(J,a))
        except: pass
j = J.list_jobs(include_disabled=True)
print('ANZAHL JOBS:', len(j))
for x in j: print(' -', (x.get('name') if isinstance(x,dict) else getattr(x,'name','?')))
" 2>&1 | head -30
echo "DEBUG FERTIG"
