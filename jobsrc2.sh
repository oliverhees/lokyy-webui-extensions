#!/bin/sh
# Im hermes-WEBUI-Container. Findet den echten WebUI-Server-Prozess (PID-NS geteilt) und
# testet mit DESSEN Python: get_hermes_home(), JOBS_FILE, list_jobs().
AGENTSRC=/home/hermeswebui/.hermes/hermes-agent
echo "### JOBSRC2 ###"
echo "=== WebUI-Server-Prozess suchen ==="
PYEXE=""; SRVPID=""
for d in /proc/[0-9]*; do
  cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
  case "$cmd" in
    *server.py*|*hermes_webui*|*hermes-webui*|*uvicorn*|*webui*)
      echo "PID ${d#/proc/}: $cmd" ; PYEXE="$d/exe" ; SRVPID="${d#/proc/}" ; break ;;
  esac
done
[ -z "$PYEXE" ] && echo "kein webui-prozess via cmdline gefunden -> versuche python-prozesse" && \
for d in /proc/[0-9]*; do
  cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
  case "$cmd" in *python*) echo "PY-PID ${d#/proc/}: $cmd"; [ -z "$PYEXE" ] && { PYEXE="$d/exe"; SRVPID="${d#/proc/}"; } ;; esac
done
echo "Server-PID: ${SRVPID:-?}"
echo "=== HOME + HERMES_HOME des Server-Prozesses ==="
[ -n "$SRVPID" ] && tr '\0' '\n' < /proc/$SRVPID/environ 2>/dev/null | grep -E "^HOME=|^HERMES_HOME=" || echo "(environ nicht lesbar)"
echo "=== live mit dem echten WebUI-Python ==="
if [ -n "$PYEXE" ]; then
  HERMES_HOME=/home/hermeswebui/.hermes PYTHONPATH="$AGENTSRC:$PYTHONPATH" "$PYEXE" -c "
import os
import cron.jobs as J
print('HOME env       :', os.environ.get('HOME'))
print('HERMES_HOME env:', os.environ.get('HERMES_HOME'))
try: print('get_hermes_home():', J.get_hermes_home())
except Exception as e: print('get_hermes_home ERR:', e)
print('JOBS_FILE      :', J.JOBS_FILE)
print('JOBS_FILE exists:', J.JOBS_FILE.exists())
print('list_jobs count:', len(J.list_jobs(include_disabled=True)))
" 2>&1 | head -20
fi
echo "FERTIG2"
