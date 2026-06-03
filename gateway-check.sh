#!/bin/sh
# Diagnose: laeuft das Gateway permanent? Im hermes-agent-Container ausfuehren.
echo "=== gateway status ==="
hermes gateway status 2>&1 | head -8
echo "=== PID 1 (Container-Hauptprozess / CMD) ==="
cat /proc/1/cmdline 2>/dev/null | tr '\0' ' '; echo
echo "=== hermes/gateway-Prozesse ==="
ps aux 2>/dev/null | grep -iE "hermes|gateway" | grep -v grep | head -6
echo "=== gateway-Subkommandos ==="
hermes gateway --help 2>&1 | head -20
echo "CHECK FERTIG"
