#!/bin/sh
# Holt alle Loki-Extensions frisch von GitHub in den webui-extension-Ordner. Im hermeswebui-Container ausführen.
EXT="${HERMES_WEBUI_EXTENSION_DIR:-/home/hermeswebui/.hermes/webui-extension}"
BASE="https://raw.githubusercontent.com/oliverhees/lokyy-webui-extensions/main"
for f in loki-orchestrator/static/loki-orchestrator.js loki-orchestrator/static/loki-orchestrator.css \
         loki-branding/static/loki.js loki-branding/static/loki.css \
         mcp-manager/static/mcp-manager.js mcp-manager/static/mcp-manager.css \
         agent-importer/static/agent-importer.js agent-importer/static/agent-importer.css; do
  name=$(basename "$f")
  if curl -fsSL "$BASE/$f" -o "$EXT/$name"; then echo "OK $name"; else echo "SKIP $name"; fi
done
echo "DEPLOY FERTIG"
