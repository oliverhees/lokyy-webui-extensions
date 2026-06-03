#!/bin/sh
# Holt alle aktiven Loki-Extensions frisch von GitHub in den webui-extension-Ordner.
# Im hermeswebui-Container ausführen:  curl -fsSL .../deploy-webui.sh | sh
EXT="${HERMES_WEBUI_EXTENSION_DIR:-/home/hermeswebui/.hermes/webui-extension}"
BASE="https://raw.githubusercontent.com/oliverhees/lokyy-webui-extensions/main"

# Obsolete Extensions entfernen (loki-orchestrator = Multi-Agent-Chat, verworfen zugunsten
# Single-Agent + Skills/MCPs; Loki OS geht Richtung Dashboards + Home-Shell).
for old in loki-orchestrator.js loki-orchestrator.css; do
  [ -f "$EXT/$old" ] && rm -f "$EXT/$old" && echo "RM $old (obsolet)"
done

for f in loki-branding/static/loki.js loki-branding/static/loki.css \
         mcp-manager/static/mcp-manager.js mcp-manager/static/mcp-manager.css \
         agent-importer/static/agent-importer.js agent-importer/static/agent-importer.css; do
  name=$(basename "$f")
  if curl -fsSL "$BASE/$f" -o "$EXT/$name"; then echo "OK $name"; else echo "SKIP $name"; fi
done
echo "DEPLOY FERTIG"
