# Lokyy WebUI Extensions

Sammlung von Extensions für die **Hermes WebUI** (`nesquena/hermes-webui`) — rein
additiv über das offizielle Extension-System (`HERMES_WEBUI_EXTENSION_*`), **kein
Fork**, überlebt Upstream-Updates. Basis für Lokyy OS / das KIMIBOCA-Bootcamp.

## Extensions

| Extension | Zweck |
|-----------|-------|
| [`mcp-manager`](./mcp-manager) | „MCP-Server hinzufügen"-Button + Formular in Settings → System. Erlaubt nicht-technischen Usern, MCP-Server über die UI zu verwalten (statt `config.yaml` von Hand). |
| [`agent-importer`](./agent-importer) | Importiert einen kompletten Agenten (Profil + SOUL.md + MCP + Skills) aus einem JSON-Bundle in einem Klick. Beispiel: `bundles/nina.json`. |

## Schnellinstallation (Docker / Coolify)

Dateien ins Extension-Verzeichnis im Container ziehen + ENV setzen + Restart.
Details je Extension in deren `README.md`.

```bash
# im hermes-webui-Container (persistentes Volume):
mkdir -p /home/hermeswebui/.hermes/webui-extension
cd /home/hermeswebui/.hermes/webui-extension
curl -sLO https://raw.githubusercontent.com/oliverhees/lokyy-webui-extensions/main/mcp-manager/static/mcp-manager.js
curl -sLO https://raw.githubusercontent.com/oliverhees/lokyy-webui-extensions/main/mcp-manager/static/mcp-manager.css
```

ENV (in der Compose-Datei beim `hermes-webui`-Service):
```yaml
HERMES_WEBUI_EXTENSION_DIR: /home/hermeswebui/.hermes/webui-extension
HERMES_WEBUI_EXTENSION_SCRIPT_URLS: /extensions/mcp-manager.js
HERMES_WEBUI_EXTENSION_STYLESHEET_URLS: /extensions/mcp-manager.css
```

Mehrere Extensions: Script-/Stylesheet-URLs kommagetrennt anhängen.
