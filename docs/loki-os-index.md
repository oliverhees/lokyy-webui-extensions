# 📍 Lokyy OS — Index (Lokyy-Brain-Referenzen)

> Lokaler Spiegel des MOC. Alle Lokyy-OS-Elemente in Lokyy Brain wiederfinden.
> Zentraler MOC in Lokyy: `10_projects/lokyy/os/INDEX-loki-os`

## Lokyy-Brain-Notizen (Pfad → Inhalt)

### Vision & Architektur
- `10_projects/lokyy/os/shared-workspace-second-brain` — Projekt-Rückgrat: Second Brain als geteilter Workspace, 5 Schichten, Repo-Topologie (Weg B), Sync-Strategie, 🔴🟡🟢, Login/2FA, Risiken
- `50_decisions/2026-06-03-loki-os-roadmap-und-architektur-entscheidungen` — Roadmap (Phasen 0–5) + 3 Kern-Entscheidungen (Binär→Nextcloud, zwei Einstiege, Pipes bleiben in Brain)
- `20_notes/2026-06-03-loki-os-hub-architektur-mcp-foederation` — Hub-Prinzip: Text/Binär-Trennung, Referenzieren statt Kopieren, MCP-Föderation, alles remote
- `20_notes/2026-06-03-loki-os-nextcloud-und-settings` — Nextcloud (Objektspeicher+Kalender), privat+shared, Zugriffskontrolle, Lokyy-OS-Settings/Connections

### Mechanik & gelöste Bugs (gebaut & verifiziert)
- `20_notes/2026-06-03-loki-os-spaces-workspaces-mechanik` — Spaces: anlegen→Space→wechseln, Auto-Create-Lücke, Trust-Regeln
- `50_decisions/2026-06-03-loki-os-two-container-fix` — Gateway permanent, geteilter Workspace, cron-Jobs, Profil-Mismatch
- `20_notes/2026-06-03-workspace-panel-leer-bug` — Workspace-Panel leer → Space aktiv wählen; loki-workspace-Extension
- `20_notes/2026-06-03-loki-notifications-extension` — Notification-Center (Glocke, Popups, Event-System)

## Code & Artefakte (dieses Repo)
- `loki-notifications/static/` — Glocke + Notification-Center (3-Spalter Top-Bar)
- `loki-workspace/static/loki-workspace.js` — Workspace-Auto-Aktivierung + Settings-Toggle
- `loki-dashboards/`, `loki-branding/`, `mcp-manager/`, `agent-importer/`
- `loki-skills/dashboard-data/SKILL.md` — cron schreibt schemakonforme JSON
- `deploy-webui.sh` — Extensions nach /extensions/ deployen
- `docs/loki-os-architektur.html` — Hub-Architektur (visuell)

## Infrastruktur-Status
- Hermes WebUI ✅ remote (Coolify) · Forgejo ✅ · Lokyy Brain ✅ (eigene PWA+MCP+Pipes) · Nextcloud ⏳

## Roadmap-Kurzform
0 Remote-Fundament (Nextcloud offen) · 1 Privat-Sync · 2 Nextcloud · 3 Freigabe+Shared · 4 Auth/2FA+Multi-User · 5 Politur
