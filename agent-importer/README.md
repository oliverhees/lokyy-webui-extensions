# Agent Importer — Hermes WebUI Extension

Importiert einen **kompletten Agenten** aus einem JSON-Bundle in **einem Schritt** —
Profil + echte Agenten-Seele (SOUL.md) + MCP-Server + Skills. Fügt im Profile-Panel
einen Button **„📥 Agent importieren"** hinzu.

Nutzt nur existierende, authentifizierte WebUI-Endpoints (kein Core-Fork):
`POST /api/profile/create` → `POST /api/profile/switch` → `POST /api/memory/write` (section=soul) →
`PUT /api/mcp/servers/{name}` → `POST /api/skills/save`.

> **Voraussetzung:** hermes-webui **≥ v0.51.127** (für die Write-Endpoints). Ältere Versionen
> liefern 501. Siehe `mcp-manager/README.md` zum Image-Update.

## Bundle-Format

```json
{
  "name": "nina",
  "role": "Grafikerin",
  "description": "kurze Rollenbeschreibung",
  "model_provider": "anthropic",        // optional — sonst in der UI wählbar
  "default_model": "<modell>",          // optional
  "soul": "…komplette SOUL.md (Markdown)…",
  "mcp_servers": [
    { "name": "kie-ai", "url": "https://…/mcp", "auth": "__PROMPT__" },
    { "name": "lokal", "command": "npx", "args": ["-y","…"], "env": {"KEY":"val"} }
  ],
  "skills": [
    { "name": "brand-visuals", "category": "design", "content": "---\nname: …\n---\n# Skill…" }
  ]
}
```

- **`auth": "__PROMPT__"`** → das Token wird beim Import **sicher abgefragt** (per Dialog),
  landet **nie** im Bundle. Ideal für öffentlich gehostete Kurs-Bundles.
- `model_provider` / `default_model` sind optional; ohne sie wird das Profil mit
  System-Default angelegt und das Modell ist in der Profil-UI wählbar.

## Nutzung

1. Profile-Panel (Person-Icon) → **„📥 Agent importieren"**
2. Bundle-URL eingeben (z.B. ein `…/bundles/nina.json` Raw-Link) **oder** Datei hochladen
3. **Importieren** → Fortschritt wird live geloggt
4. Token(s) eingeben, wenn abgefragt
5. Danach: im Chat einmal **`/reload-mcp`** → die MCP-Tools des Agenten werden aktiv

Nach dem Import bist du **im Profil des neuen Agenten** — über das Profil-Menü zurückwechseln.

## Beispiel-Bundle

[`bundles/nina.json`](../bundles/nina.json) — Nina, Grafikerin, mit kie-ai + Brand-Visuals-Skill.
Quelle generiert aus `bundles/_build-nina.mjs` (sauberes JSON-Escaping).

## Installation

Wie `mcp-manager` — Dateien ins Extension-Verzeichnis, ENV ergänzen (kommagetrennt):

```
HERMES_WEBUI_EXTENSION_SCRIPT_URLS=/extensions/mcp-manager.js,/extensions/agent-importer.js
HERMES_WEBUI_EXTENSION_STYLESHEET_URLS=/extensions/mcp-manager.css,/extensions/agent-importer.css
```
Dateien im Container ziehen:
```bash
cd /home/hermeswebui/.hermes/webui-extension
curl -sLO https://raw.githubusercontent.com/oliverhees/lokyy-webui-extensions/main/agent-importer/static/agent-importer.js
curl -sLO https://raw.githubusercontent.com/oliverhees/lokyy-webui-extensions/main/agent-importer/static/agent-importer.css
```
→ Redeploy + Hard-Reload.
