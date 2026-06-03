#!/bin/sh
# WICHTIG: im hermes-WEBUI-Container ausfuehren (nicht im agent!).
echo "=== User / HOME / HERMES_HOME ==="
(whoami 2>/dev/null || id -un 2>/dev/null || echo "uid=$(id -u)")
echo "HOME=$HOME"
echo "HERMES_HOME=${HERMES_HOME:-<unset>}"
echo "=== jobs.json sichtbar + lesbar? ==="
ls -la /home/hermeswebui/.hermes/cron/jobs.json 2>/dev/null || echo "FEHLT/UNSICHTBAR: jobs.json"
echo "=== cron-Ordner Rechte ==="
ls -lad /home/hermeswebui/.hermes /home/hermeswebui/.hermes/cron 2>/dev/null
echo "=== Inhalt lesbar? (Job-Namen) ==="
grep -o '"name":[^,}]*' /home/hermeswebui/.hermes/cron/jobs.json 2>/dev/null || echo "(nicht lesbar)"
echo "WEBUI-CRON-CHECK FERTIG"
