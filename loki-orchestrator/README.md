# Loki Orchestrator — Hermes WebUI Extension

**„Mira dirigiert das Team"** — ein Multi-Agent-Orchestrierungs-Panel für Loki OS. Gibt der Hermes WebUI einen eigenen Reiter **🐺 Loki Orchestrator**, in dem du dem Orchestrator-Agenten eine Mission gibst und das Team-Kanban live mitläufst.

- **Kein Fork.** Nutzt das offizielle Extension-System von `nesquena/hermes-webui` (`HERMES_WEBUI_EXTENSION_*`) und ausschließlich existierende, getestete WebUI-Endpoints.
- **Rein additiv.** Neuer Nav-Eintrag + eigenes Panel als Geschwister der bestehenden Views. Kein `innerHTML`-Overwrite großer Container, kein Core-Patch — überlebt Upstream-Updates.
- **Idempotent.** Guard gegen Doppel-Injektion; re-injiziert sich sauber bei Re-Render.

## Was es tut

1. **Nav-Eintrag „🐺 Loki Orchestrator"** in der Rail (Desktop) und Sidebar-Nav (Mobile).
2. **Mission starten:** Textfeld + Orchestrator-Profil-Dropdown + Button. Legt eine Session an
   (`POST /api/session/new`) und schickt die Mission an den gewählten Agent
   (`POST /api/chat/start`). Der Agent zerlegt die Mission selbst (via Kanban-Toolset).
   Live-Antwort/Reasoning wird via SSE (`GET /api/chat/stream`) im Panel gestreamt.
3. **Live-Team-Board:** `GET /api/kanban/board`, gerendert als feste Spalten
   **triage / todo / ready / running / blocked / done** mit Task-Karten
   (Titel + Worker-Badge aus `assignee` + Priorität/Meta). Live-Aktualisierung via
   `EventSource` auf `GET /api/kanban/events/stream`; Fallback: Polling alle 5 s.
4. **Dispatch-Button:** `POST /api/kanban/dispatch?max=8` — spawnt bereitstehende Worker
   für `ready`-Tasks, mit Toast-Rückmeldung.
5. **Robust gegen fehlende Endpoints:** Ist die Kanban-Bridge nicht aktiv (404/503),
   zeigt das Panel eine klare Meldung statt zu brechen.

## Voraussetzung

- Ein **Orchestrator-Profil mit Kanban-Toolset** (z.B. Mira). Nur ein Agent, der die
  Kanban-Tools nutzen darf, kann eine Mission in Team-Tasks zerlegen und Worker zuweisen.
- Die **Kanban-Bridge** muss in deinem Hermes aktiv sein (Endpoint `/api/kanban/board`
  erreichbar). Ohne sie funktioniert die Mission-Eingabe weiterhin, das Board zeigt aber
  den Fehlerzustand.

## Dateien

```
static/loki-orchestrator.js     ← die Extension-Logik
static/loki-orchestrator.css    ← Styling (passt sich ans Dark-Theme an)
```

## Installation — generisch (lokal / VPS)

```bash
# 1. Extension-Dateien an einen festen Ort legen (NICHT user-writable für Fremde)
mkdir -p ~/.hermes/webui-extension
cp static/loki-orchestrator.js static/loki-orchestrator.css ~/.hermes/webui-extension/

# 2. ENV-Variablen setzen, BEVOR die WebUI startet
export HERMES_WEBUI_EXTENSION_DIR=~/.hermes/webui-extension
export HERMES_WEBUI_EXTENSION_SCRIPT_URLS=/extensions/loki-orchestrator.js
export HERMES_WEBUI_EXTENSION_STYLESHEET_URLS=/extensions/loki-orchestrator.css

# 3. WebUI neu starten
```

Mehrere Extensions kombinieren: URLs einfach kommagetrennt anhängen, z.B.
`HERMES_WEBUI_EXTENSION_SCRIPT_URLS=/extensions/mcp-manager.js,/extensions/loki-orchestrator.js`
und analog die Stylesheet-URLs.

## Installation — Coolify (Container-Setup)

Die WebUI läuft als Container, daher müssen die Dateien **in den Container** und die ENV-Vars in Coolify gesetzt werden.

1. **Persistent Storage anlegen** (Coolify → deine hermes-webui-Resource → *Storages*):
   - Mount-Path im Container z.B. `/extensions-src` (überlebt Redeploys).
2. **Dateien dort ablegen:** `loki-orchestrator.js` + `loki-orchestrator.css` in das gemountete
   Volume kopieren (WebUI-Files-Panel, Coolify-Terminal oder SSH auf den Host → Volume-Pfad).
3. **Environment Variables setzen** (Coolify → *Environment Variables*):
   ```
   HERMES_WEBUI_EXTENSION_DIR=/extensions-src
   HERMES_WEBUI_EXTENSION_SCRIPT_URLS=/extensions/loki-orchestrator.js
   HERMES_WEBUI_EXTENSION_STYLESHEET_URLS=/extensions/loki-orchestrator.css
   ```
   Bereits vorhandene Extensions: einfach kommagetrennt ergänzen.
4. **Redeploy / Restart** der Resource.

> Der genaue Mount-Path hängt vom Image ab. Bei `nesquena/hermes-webui` liegt der
> Standard-State unter `/home/hermeswebui/.hermes/`. Wenn unklar, Setup gemeinsam mit
> Alice am echten Container verifizieren.

## Verifikation

1. WebUI öffnen → in der linken **Rail** erscheint ein neues Icon **🐺 Loki Orchestrator**
   (zwischen den Funktions-Tabs und dem Zahnrad/Settings).
2. Klick → das Loki-Panel öffnet sich: oben Mission-Eingabe, darunter das Team-Board
   mit den sechs Spalten.
3. Orchestrator-Profil wählen, eine Mission eintippen, **▶ Mission starten** → der
   Mission-Status meldet „Mira arbeitet" und die Live-Antwort streamt ein.
4. Sobald der Agent Tasks anlegt, erscheinen sie im Board. **🚀 Dispatch** spawnt die Worker.

## Genutzte Endpoints (alle gegen `nesquena/hermes-webui` @ master verifiziert)

| Methode | Pfad | Zweck |
|---------|------|-------|
| `GET`  | `/api/profiles` | Orchestrator-Profil-Dropdown (Feld `profiles[].name`, `active`) |
| `GET`  | `/api/kanban/assignees` | Fallback fürs Dropdown (bereits genutzte Worker-Namen) |
| `POST` | `/api/session/new` | Session anlegen (liefert `session.session_id`) |
| `POST` | `/api/chat/start` | Mission an den Orchestrator (liefert `stream_id`) |
| `GET`  | `/api/chat/stream?stream_id=…` | SSE-Live-Antwort (Events `token`, `reasoning`, `tool`, `stream_end`) |
| `GET`  | `/api/kanban/board` | Board (Spalten `columns[].name` + `tasks[]`) |
| `GET`  | `/api/kanban/events/stream` | SSE-Live-Updates (Event `events` → Board neu laden) |
| `POST` | `/api/kanban/dispatch?max=8` | Worker für `ready`-Tasks spawnen |

Feste Board-Spalten (`BOARD_COLUMNS`): `triage`, `todo`, `ready`, `running`, `blocked`, `done`.

## CSRF / Auth

Die Extension ruft alle Endpoints über die globale Host-Funktion `window.api()` auf (regelt
`credentials` und Login-Redirect); Fallback ist ein same-origin `fetch`. Den CSRF-Token setzt
nicht `api()` selbst, sondern ein globaler `window.fetch`-Wrapper in `index.html`, der den
`X-Hermes-CSRF-Token` in **jeden** fetch injiziert — dadurch sind beide `callApi`-Pfade
(`api()` und der fetch-Fallback) abgedeckt. Bei lokalem Hermes ohne aktivierte Auth genügt
same-origin; der CSRF-Token wird serverseitig nur bei aktivierter Auth geprüft. SSE-Verbindungen
laufen über `EventSource` (same-origin, mit Cookies).

## Sicherheit

Extensions laufen mit voller Session-Autorität (Trust-Modell des Extension-Systems). Nur Extensions
aus eigener/vertrauter Quelle aktivieren. `HERMES_WEBUI_EXTENSION_DIR` nicht auf ein für Fremde
beschreibbares Verzeichnis zeigen lassen. WebUI-Passwortschutz aktiv lassen.

---
*Teil von `lokyy-webui-extensions` · erstellt mit Alice für Lokyy OS / KIMIBOCA.*
