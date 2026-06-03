#!/bin/sh
# In BEIDEN Containern ausfuehren (hermes-agent UND hermeswebui). Zeigt Workspace/Volumes/cron-DB.
echo "### CONTAINER: $(hostname)"
echo "=== HERMES_HOME ==="; echo "${HERMES_HOME:-<unset>}"
echo "=== workspace/data-Env ==="; env | grep -iE "workspace|hermes_home|HERMES_.*DIR|opt/data" | head
echo "=== /opt/data ? ==="; ls -la /opt/data 2>/dev/null | head -8 || echo "kein /opt/data"
echo "=== Volume-Mounts ==="; grep -iE " /opt/data| /home| /workspace|hermes" /proc/mounts 2>/dev/null | awk '{print $1, $2, $3}' | head -12
echo "=== cron-DB Ort ==="; find / -maxdepth 6 \( -name "cron*.db" -o -name "cron*.json" -o -name "*crontab*" \) 2>/dev/null | grep -viE "/proc|/sys|skills|node_modules" | head
echo "WSCHECK FERTIG ($(hostname))"
