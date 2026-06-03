#!/bin/sh
# Installiert die Loki-Skills in ~/.hermes/skills/ (Auto-Discovery). Im hermes-agent-Container ausführen:
#   curl -fsSL .../setup-skills.sh | sh
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
SK="$HOME_DIR/skills/loki"
BASE="https://raw.githubusercontent.com/oliverhees/lokyy-webui-extensions/main/loki-skills"
mkdir -p "$SK/dashboard-data"
if curl -fsSL "$BASE/dashboard-data/SKILL.md" -o "$SK/dashboard-data/SKILL.md"; then
  echo "OK dashboard-data → $SK/dashboard-data/SKILL.md"
else
  echo "FEHLER beim Holen von dashboard-data/SKILL.md"
fi
echo "SKILLS FERTIG"
