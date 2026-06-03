#!/bin/sh
# Legt den Daily-Research-Cron-Task an (nutzt Skill dashboard-data) und fuehrt ihn einmal aus.
# Im hermes-agent-Container:  curl -fsSL .../setup-research-task.sh | sh
PROMPT="Recherchiere kurz das wichtigste KI- oder Tech-Thema von heute. Nutze den Skill dashboard-data mit Ziel-Ordner research und den Feldern date, topic, summary, key_points (Array von Strings), sources (Array von URLs). Lege beim ersten Lauf research/schema.json an. Schreibe das Ergebnis als JSON-Datei in research/daten/ benannt nach dem heutigen Datum im Format YYYY-MM-DD (z.B. 2026-06-03.json), strikt schemakonform."
# Falls schon vorhanden, erst entfernen (idempotent):
hermes cron remove daily-research >/dev/null 2>&1
hermes cron create "0 9 * * *" "$PROMPT" --skill dashboard-data --name daily-research --workdir /workspace
echo "--- cron list ---"
hermes cron list
echo "--- jetzt einmal ausfuehren (erzeugt /workspace/research/) ---"
hermes cron run daily-research
echo "TASK ANGELEGT + EINMAL GETRIGGERT (laeuft beim naechsten Scheduler-Tick)"
