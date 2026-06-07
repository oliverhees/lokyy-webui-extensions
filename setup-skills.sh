#!/bin/sh
# Installiert die Loki-Skills in ~/.hermes/skills/ (Auto-Discovery). Im hermes-agent-Container ausführen:
#   curl -fsSL .../setup-skills.sh | sh
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
SK="$HOME_DIR/skills/loki"
BASE="https://raw.githubusercontent.com/oliverhees/lokyy-webui-extensions/main/loki-skills"
for skill in dashboard-data dashboard-builder; do
  mkdir -p "$SK/$skill"
  if curl -fsSL "$BASE/$skill/SKILL.md" -o "$SK/$skill/SKILL.md"; then
    echo "OK $skill → $SK/$skill/SKILL.md"
  else
    echo "FEHLER beim Holen von $skill/SKILL.md"
  fi
done
echo "SKILLS FERTIG"
