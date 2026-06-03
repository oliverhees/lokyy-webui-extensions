#!/bin/sh
# Im hermes-WEBUI-Container. Findet das WebUI-Python ueber das Init-Skript und ruft list_jobs() live auf.
AGENTSRC=/home/hermeswebui/.hermes/hermes-agent
echo "### JOBSRC3 ###"
echo "=== Init-Skript: python/venv-Hinweise ==="
grep -iE "python|venv|VIRTUAL_ENV|uvicorn|exec |server" /hermeswebui_init.bash 2>/dev/null | head -15
echo ""
echo "=== Python mit yaml UND cron.jobs-Import (nicht agent-venv) ==="
PY=""
CANDS="$(grep -oE '/[A-Za-z0-9_./-]*/bin/python[0-9.]*' /hermeswebui_init.bash 2>/dev/null) /usr/local/bin/python3 /usr/bin/python3 $(find /opt /app /usr/local -maxdepth 5 -name 'python3*' -type f 2>/dev/null | grep -v "$AGENTSRC" | head)"
for p in $CANDS; do
  [ -x "$p" ] || continue
  if "$p" -c "import yaml" 2>/dev/null; then PY="$p"; echo "Python mit yaml: $p"; break; fi
done
[ -z "$PY" ] && { echo "kein passendes Python gefunden"; echo FERTIG3; exit 0; }
echo ""
echo "=== LIVE: get_hermes_home / JOBS_FILE / list_jobs ==="
HERMES_HOME=/home/hermeswebui/.hermes PYTHONPATH="$AGENTSRC:$PYTHONPATH" "$PY" -c "
import os
import cron.jobs as J
print('HOME           :', os.environ.get('HOME'))
print('HERMES_HOME    :', os.environ.get('HERMES_HOME'))
try: print('get_hermes_home():', J.get_hermes_home())
except Exception as e: print('get_hermes_home ERR:', repr(e))
print('JOBS_FILE      :', J.JOBS_FILE)
print('JOBS_FILE.exists:', J.JOBS_FILE.exists())
print('list_jobs count:', len(J.list_jobs(include_disabled=True)))
" 2>&1 | head -20
echo "FERTIG3"
