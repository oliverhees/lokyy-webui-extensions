#!/bin/sh
# Prueft, ob der cron-Scheduler tickt und der daily-research-Task gelaufen ist.
echo "=== cron list ==="; hermes cron list 2>&1
echo "=== cron status ==="; hermes cron status 2>&1 | head
echo "=== research-Daten erzeugt? ==="
find / -maxdepth 8 -path "*research/daten*" -name "*.json" 2>/dev/null | grep -v /proc/ | head
echo "--- research-Ordner ---"
find / -maxdepth 8 -type d -name research 2>/dev/null | grep -v /proc/ | head
echo "CHECK FERTIG"
