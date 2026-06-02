# MCP Manager — Hermes WebUI Extension

Fügt der **Settings → System → MCP-Server**-Sektion einen Button **„➕ MCP-Server hinzufügen"** hinzu — mit Formular zum Anlegen (HTTP/Remote oder stdio/Lokal) und Löschen vorhandener Server. Damit können **nicht-technische User MCP-Server über die UI verwalten**, ohne `config.yaml` von Hand zu editieren.

- **Kein Fork.** Nutzt das offizielle Extension-System von `nesquena/hermes-webui` (`HERMES_WEBUI_EXTENSION_*`) und die bereits existierenden Endpoints `PUT/DELETE/GET /api/mcp/servers`.
- **Überlebt Upstream-Updates** (rein additiv, kein Core-Patch).

## Dateien

```
static/mcp-manager.js     ← die Extension-Logik
static/mcp-manager.css    ← Styling (passt sich ans Dark-Theme an)
```

## Installation — generisch (lokal / VPS)

```bash
# 1. Extension-Dateien an einen festen Ort legen (NICHT user-writable für Fremde)
mkdir -p ~/.hermes/webui-extension
cp static/mcp-manager.js static/mcp-manager.css ~/.hermes/webui-extension/

# 2. ENV-Variablen setzen, BEVOR die WebUI startet
export HERMES_WEBUI_EXTENSION_DIR=~/.hermes/webui-extension
export HERMES_WEBUI_EXTENSION_SCRIPT_URLS=/extensions/mcp-manager.js
export HERMES_WEBUI_EXTENSION_STYLESHEET_URLS=/extensions/mcp-manager.css

# 3. WebUI neu starten
```

Mehrere Extensions später: URLs einfach kommagetrennt anhängen, z.B.
`HERMES_WEBUI_EXTENSION_SCRIPT_URLS=/extensions/mcp-manager.js,/extensions/naechste-ext.js`

## Installation — Coolify (dein Setup)

Die WebUI läuft als Container, daher müssen die Dateien **in den Container** und die ENV-Vars in Coolify gesetzt werden.

1. **Persistent Storage anlegen** (Coolify → deine hermes-webui-Resource → *Storages*):
   - Mount-Path im Container z.B. `/extensions-src`
   - (Das überlebt Redeploys.)
2. **Dateien dort ablegen:** `mcp-manager.js` + `mcp-manager.css` in das gemountete Volume kopieren (über das WebUI-Files-Panel, Coolify-Terminal oder SSH auf den Host → Volume-Pfad).
3. **Environment Variables setzen** (Coolify → *Environment Variables*):
   ```
   HERMES_WEBUI_EXTENSION_DIR=/extensions-src
   HERMES_WEBUI_EXTENSION_SCRIPT_URLS=/extensions/mcp-manager.js
   HERMES_WEBUI_EXTENSION_STYLESHEET_URLS=/extensions/mcp-manager.css
   ```
4. **Redeploy / Restart** der Resource.

> Der genaue Mount-Path hängt vom Image ab (Standard-State liegt bei
> `nesquena/hermes-webui` unter `/home/hermeswebui/.hermes/`). Wenn unklar,
> Setup gemeinsam mit Alice am echten Container verifizieren.

## Verifikation

1. WebUI öffnen → **Settings (Zahnrad) → System** → zur MCP-Server-Box scrollen.
2. Der Button **„➕ MCP-Server hinzufügen"** steht direkt über der Server-Liste.
3. Klick → Formular → z.B. Lokyy Brain als HTTP-Server eintragen → Speichern.
4. Server erscheint in der Liste.

## Reload-Verhalten (wichtig)

- **Neue** Server: werden beim nächsten Chat automatisch aktiv (kein Neustart nötig).
- **Geänderte/gelöschte** Server: greifen erst nach einem **Hermes-Neustart** zuverlässig (prozess-globales MCP-Registry). In Coolify = 1 Klick „Restart".

## Sicherheit

Extensions laufen mit voller Session-Autorität (Trust-Modell des Extension-Systems). Nur Extensions aus eigener/vertrauter Quelle aktivieren. `HERMES_WEBUI_EXTENSION_DIR` nicht auf ein für Fremde beschreibbares Verzeichnis zeigen lassen. WebUI-Passwortschutz aktiv lassen.

---
*Teil von `lokyy-webui-extensions` · erstellt mit Alice für Lokyy OS / KIMIBOCA.*
