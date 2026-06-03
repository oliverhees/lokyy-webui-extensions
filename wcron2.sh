#!/bin/sh
# Im hermes-WEBUI-Container. Findet das venv-Python (mit yaml) robust und testet list_jobs() direkt.
AGENTSRC=/home/hermeswebui/.hermes/hermes-agent
echo "### VERSION 2 ###"
echo "=== venv mit yaml suchen ==="
PY=""
SP=$(find / -maxdepth 9 -type d -name yaml -path "*site-packages*" 2>/dev/null | grep -v /proc/ | head -1)
echo "yaml site-packages: ${SP:-keins}"
if [ -n "$SP" ]; then
  VENV=$(echo "$SP" | sed 's@/lib/.*@@')
  [ -x "$VENV/bin/python" ]  && PY="$VENV/bin/python"
  [ -z "$PY" ] && [ -x "$VENV/bin/python3" ] && PY="$VENV/bin/python3"
fi
if [ -z "$PY" ]; then
  for c in $(find / \( -name python3 -o -name python \) -type f 2>/dev/null | grep -vE "/proc/|$AGENTSRC" | sort -u); do
    "$c" -c "import yaml" 2>/dev/null && PY="$c" && break
  done
fi
echo "Python: ${PY:-NICHT GEFUNDEN}"
[ -z "$PY" ] && { echo "Abbruch - kein python mit yaml"; exit 0; }
echo "=== list_jobs() Direkttest (HERMES_HOME=/home/hermeswebui/.hermes) ==="
HERMES_HOME=/home/hermeswebui/.hermes PYTHONPATH="$AGENTSRC:$PYTHONPATH" "$PY" -c "
import os
from cron import jobs as J
print('HOME(env):', os.environ.get('HERMES_HOME'))
for a in dir(J):
    if 'PATH' in a.upper() or a.upper().endswith('HOME'):
        try: print('  const', a, '=', getattr(J, a))
        except Exception: pass
j = J.list_jobs(include_disabled=True)
print('ANZAHL JOBS:', len(j))
for x in j:
    print(' -', (x.get('name') if isinstance(x, dict) else getattr(x, 'name', '?')))
" 2>&1 | head -30
echo "DEBUG2 FERTIG"
