---
project: lokyy-webui-extensions
task: Dashboard Write-Back — Formulare schreiben Daten zurück in den Workspace
slug: dashboard-write-back
effort: E3
phase: complete
progress: 39/39
mode: build
started: 2026-06-07T00:00:00Z
updated: 2026-06-07T00:00:00Z
---

# ISA — Lokyy WebUI Extensions: Dashboard Write-Back

## Problem

Die loki-dashboards-Extension kann Dashboards nur ANZEIGEN (Parent lädt `daten/*.json`, injiziert `window.LOKI_DATA` in ein sandboxed iframe). Es gibt keinen Rückkanal: Ein Formular im Dashboard (z.B. Blutdruck-Eintrag im Health-Dashboard) kann nichts speichern. Hermes' Vorschlag (eigener Python-Server) wäre ein Fremdkörper am Workspace-Modell vorbei. Zudem existiert der Dashboard-Builder-Skill, auf den `dashboard-data/SKILL.md` verweist, noch gar nicht — Dashboards mit Formularen kann derzeit niemand systematisch bauen.

## Vision

Oliver trägt im Health-Dashboard seinen Blutdruck ein, klickt Speichern, die Charts aktualisieren sich sofort — und die JSON-Datei liegt im Workspace, wo der Lokyy-Agent sie sieht und weiterverarbeiten kann. Dashboard-Bau per Skill fragt von selbst: "Soll man hier auch etwas eintragen können?" Das Dateisystem ist der Bus zwischen Mensch, Dashboard und Agent.

## Out of Scope

Kein eigener Server/Daemon, keine neue Auth, kein Fork von hermes-webui. Kein Lockern der iframe-Sandbox (`allow-same-origin` bleibt verboten). Kein Löschen/Umbenennen von Dateien aus dem Dashboard heraus (nur Schreiben in `daten/`). Keine Mehrbenutzer-Konfliktlösung (last-write-wins pro Datei genügt). Kein Schema-Editor im Dashboard.

## Constraints

- Schreiben ausschließlich über den verifizierten Host-Endpoint `POST /api/file/save` mit `{session_id, path, content}` (gegen `static/workspace.js` des Upstream-Repos verifiziert).
- Das iframe bleibt `sandbox="allow-scripts"` ohne `allow-same-origin` — es darf selbst KEINE API-Calls machen; jede Schreiboperation läuft als Anfrage (`postMessage`) an den Parent, der allein validiert und schreibt.
- Der Parent schreibt NUR in den `daten/`-Unterordner des aktuell geöffneten Dashboards, nur `*.json`, Dateiname streng sanitized.
- Rein additiv, idempotent, Vanilla JS ohne Build-Step (Extensions-Konvention).
- Datenkontrakt von `dashboard-data` bleibt gültig: flache JSON-Objekte mit Pflichtfeld `date` (YYYY-MM-DD), `schema.json` ist der Vertrag für beide Schreibwege (Agent + Formular).

## Goal

Die loki-dashboards-Extension besitzt eine sichere postMessage→`/api/file/save`-Write-Back-Bridge mit injiziertem `LOKI.save()`-Helper; das Gesundheits-Beispiel demonstriert ein funktionierendes Formular; ein neuer `dashboard-builder`-Skill (plus aktualisierter `dashboard-data`-Skill und `setup-skills.sh`) macht Formular-Bedarf zur Pflichtfrage beim Dashboard-Bau.

## Criteria

### Bridge (Extension)
- [x] ISC-1: `buildSrcdoc` injiziert `window.LOKI` mit `save()`-Funktion, die ein Promise zurückgibt
- [x] ISC-2: `window.LOKI_DATA`/`window.LOKI_DASHBOARD` bleiben unverändert gesetzt (Rückwärtskompatibilität)
- [x] ISC-3: `message`-Listener wird genau einmal registriert (idempotent, Doppel-Load-sicher)
- [x] ISC-4: Listener akzeptiert nur Events mit `event.source === ` contentWindow des aktiven Dashboard-iframes
- [x] ISC-5: Nachrichten ohne `type === 'loki:save'` werden ignoriert (kein Throw, kein Seiteneffekt)
- [x] ISC-6: Dateinamen-Sanitizer verwirft `/`, `\`, `..` und erzwingt `^[A-Za-z0-9._-]+\.json$`
- [x] ISC-7: Ohne expliziten Dateinamen wird `<data.date>.json`, sonst `<heute>.json` verwendet
- [x] ISC-8: Zielpfad ist immer `<dashboardOrdner>/daten/<datei>` des AKTUELL geöffneten Dashboards
- [x] ISC-9: Nicht-Objekt-Payloads (String, Array, null) werden mit Fehler-Result abgelehnt
- [x] ISC-10: Payload-Größe > 256 KB wird mit Fehler-Result abgelehnt
- [x] ISC-11: Fehlendes `date`-Feld wird vom Parent mit dem heutigen Datum (YYYY-MM-DD) ergänzt
- [x] ISC-12: Schreiben erfolgt via `POST /api/file/save`; bei 404 (Datei neu) Fallback `POST /api/workspace/upload` multipart (refined 2026-06-07)
- [x] ISC-13: Erfolgs-Result `{type:'loki:save:result', reqId, ok:true, rows}` enthält frisch geladene Daten
- [x] ISC-14: Fehler-Result `{ok:false, error}` wird ans iframe zurückgepostet (inkl. Hinweis auf evtl. fehlenden `daten/`-Ordner)
- [x] ISC-15: `reqId` aus der Anfrage wird im Result unverändert zurückgegeben (Promise-Zuordnung im iframe)
- [x] ISC-16: Toast bei Erfolg und Fehler über den verifizierten Host-`showToast`-Wrapper
- [x] ISC-17: iframe-Attribut ist `sandbox="allow-scripts allow-forms"` — KEIN allow-same-origin (refined 2026-06-07, siehe Decisions/Changelog)
- [x] ISC-18: `node --check` auf loki-dashboards.js läuft fehlerfrei

### Anti-Kriterien
- [x] ISC-19: Anti: Kein `fetch`/`XMLHttpRequest` im injizierten Helper oder im Beispiel-Dashboard
- [x] ISC-20: Anti: Kein Codepfad schreibt außerhalb von `<dashboardOrdner>/daten/` (Sanitizer + Pfad-Konstruktion)
- [x] ISC-21: Anti: Kein `eval`/`new Function` im injizierten Helper
- [x] ISC-22: Anti: Kein Schreibvorgang ohne explizite `loki:save`-Nachricht aus dem iframe

### Beispiel-Dashboard (gesundheit)
- [x] ISC-23: dashboard.html enthält ein Eintrags-Formular (Schritte, Schlaf, HRV) mit Datum
- [x] ISC-24: Submit ruft `LOKI.save()` auf und deaktiviert den Button während des Speicherns
- [x] ISC-25: Erfolgsfall rendert Karten + Sparkline aus den zurückgegebenen `rows` neu
- [x] ISC-26: Fehlerfall zeigt eine sichtbare Fehlermeldung im Formularbereich
- [x] ISC-27: Formular ist auch bei leerem `LOKI_DATA` nutzbar (erster Eintrag möglich)
- [x] ISC-28: Header-Kommentar dokumentiert den `LOKI.save`-Kontrakt für Skill-Übernahme

### Skills
- [x] ISC-29: `loki-skills/dashboard-builder/SKILL.md` existiert mit gültigem Frontmatter (name, description, hermes-metadata)
- [x] ISC-30: Builder-Skill enthält PFLICHT-Frageblock: Nur-Anzeige vs. Formular, Felder, Eintragsfrequenz — vor dem Bau zu klären
- [x] ISC-31: Builder-Skill dokumentiert beide Kontrakte (`LOKI_DATA` lesen, `LOKI.save` schreiben) + Sandbox-Regeln (keine externen Libs, kein fetch)
- [x] ISC-32: Builder-Skill schreibt vor, beim Bau den `daten/`-Ordner anzulegen (Formular-Save trifft nie auf fehlenden Ordner)
- [x] ISC-33: `dashboard-data/SKILL.md` erwähnt den Formular-Schreibweg und dass `schema.json` der Vertrag für BEIDE Wege ist
- [x] ISC-34: `setup-skills.sh` installiert auch `dashboard-builder`
- [x] ISC-35: Git-Commit auf `main` umfasst alle geänderten/neuen Dateien (Push = Voraussetzung fürs Live-Deployment)

### Nachtrag 2026-06-07 (Live-Befund: "Blocked form submission … sandboxed")
- [x] ISC-36: Injizierter Helper unterbindet native Form-Submissions global (capture-phase `submit` → `preventDefault`), Dashboard-eigene Handler feuern weiter
- [x] ISC-37: Builder-Skill verbietet native Submission + `form.submit()` + `autofocus` explizit und schreibt `ev.preventDefault()` als erste Handler-Zeile vor
- [x] ISC-38: Live-Experiment belegt: mit `allow-forms` feuert das submit-Event im sandboxed srcdoc-iframe und `preventDefault` greift (ohne: Event feuert nie)
- [x] ISC-39: Live verifiziert (v0.51.210): file/save überschreibt nur Bestehendes (404 bei neu); workspace/upload legt neue Datei an (200, Datei im Listing)

## Test Strategy

| isc | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| 1-17, 19-22 | code | Grep auf Symbole/Patterns + Code-Read | exakt | Grep/Read |
| 18 | build | `node --check loki-dashboards.js` | exit 0 | Bash |
| 6, 9-11 | logic | Sanitizer/Validator-Logik per `node -e` Unit-Probe | alle Fälle | Bash |
| 23-28 | code | Grep/Read auf dashboard.html | exakt | Grep/Read |
| 29-34 | file | Read der Skill-Dateien + setup-skills.sh | vorhanden | Read |
| 35 | git | `git log --stat -1` | alle Dateien | Bash |
| Live-Verhalten (Formular speichert auf hermeswebui.kimiboca.de) | e2e | DEFERRED-VERIFY — Deploy läuft via `deploy-webui.sh` im Container; Follow-up: nach Push deployen + Interceptor-Probe | n/a | Interceptor |

## Features

| name | description | satisfies | depends_on | parallelizable |
|------|-------------|-----------|------------|----------------|
| bridge | Write-Back-Bridge + LOKI.save-Injection in loki-dashboards.js | ISC-1..22 | — | nein (Kern) |
| example-form | Formular im Gesundheits-Beispiel-Dashboard | ISC-23..28 | bridge (Kontrakt) | ja |
| builder-skill | Neuer dashboard-builder Skill mit Formular-Frageblock | ISC-29..32 | bridge (Kontrakt) | ja |
| data-skill-update | dashboard-data SKILL.md um Formular-Schreibweg ergänzen | ISC-33 | — | ja |
| setup-script | setup-skills.sh um dashboard-builder erweitern | ISC-34 | builder-skill | ja |
| commit | Git-Commit (+ Push für Deploy) | ISC-35 | alle | nein |

## Decisions

- 2026-06-07: Write-Back über postMessage-Bridge + Host-Endpoint `/api/file/save` statt Python-Server (Hermes-Vorschlag verworfen — Fremdkörper, eigene Auth, am Workspace-Modell vorbei). Endpoint gegen Upstream `static/workspace.js` verifiziert.
- 2026-06-07: Voice-Notifications übersprungen — Pulse (Port 31337) nicht erreichbar (curl exit 7).
- 2026-06-07: Dashboard-Builder-Skill existiert entgegen Verweis in dashboard-data/SKILL.md noch nicht → wird als Teil dieser Aufgabe neu angelegt.
- 2026-06-07: show-my-math Delegation: Beispiel/Skills nicht an Agenten parallelisiert — gleiche Kontrakt-Quelle (Bridge-Code), Übergabe-Overhead > Gewinn bei 4 kleinen Dateien. Delegation stattdessen in Review/Härtung (Forge + Code Reviewer) investiert.
- 2026-06-07: Forge-Lineage-Hinweis: codex CLI auf diesem System nicht installiert — Forge-Agent lief mit Claude-Reasoning statt GPT-5.4. Drei Fixes (Toast-Guard, Reentrancy-Guard, Leerfeld-Validierung) trotzdem korrekt; echter Cross-Vendor-Check steht damit aus.
- 2026-06-07: Review-Härtungen übernommen: stabile Intra-Tag-Sortierung (Dateiname als Sekundärschlüssel) + defensive `..`-Prüfung auf den Ordner-Teil in handleSaveRequest.
- 2026-06-07: EnterPlanMode übersprungen — Ansatz wurde im Vorturn explizit freigegeben ("Ja, baut das bitte mal ein").
- 2026-06-07: refined: ISC-17 von `allow-scripts` auf `allow-scripts allow-forms` — Live-Experiment im echten Chrome bewies: ohne allow-forms dispatcht Chromium das submit-Event NICHT (Block vor Event-Dispatch), Write-Back via submit-Handler ist damit strukturell unmöglich. Sicherheitsnetz von document- auf window-capture verlegt (als erster registrierter Listener canceled es jede native Submission vor fremdem Code). Kein neuer Exfil-Kanal: fetch/img-Beacons sind aus dem opaken Origin ohnehin möglich.

## Changelog

- conjectured: POST /api/file/save legt Dateien auch NEU an — der master-Branch-Code und die Editor-Nutzung der Host-UI decken den Create-Fall mit ab.
  refuted by: Live-Probe 2026-06-07 gegen v0.51.210 — Überschreiben einer bestehenden Datei: 200; Neuanlage: 404 {"error":"File not found"}. Die Host-UI legt neue Dateien über POST /api/workspace/upload (multipart) an.
  learned: Einen Endpoint gegen den master zu verifizieren reicht nicht — die DEPLOYTE Version ist der Vertrag. Schreibpfade immer für beide Fälle (create + update) gegen die Live-Instanz proben.
  criterion now: ISC-12 (save mit 404-Fallback auf workspace/upload) + ISC-39 (beide Fälle live geprobt).

- conjectured: Ein globaler capture-phase preventDefault-Listener fängt jede native Form-Submission im sandboxed iframe ab — allow-forms wird nicht gebraucht.
  refuted by: Live-Experiment 2026-06-07 in Olivers Chrome — in sandbox="allow-scripts" feuert das submit-Event NIE (Chromium blockt VOR dem Event-Dispatch); mit allow-forms feuert es und preventDefault greift. Der Block-Fehler trat trotz korrektem Dashboard-Code und Sicherheitsnetz weiter auf.
  learned: Browser-Sicherheitsmechanismen können VOR der Event-Pipeline greifen — ein Event-Listener kann nur abfangen, was überhaupt dispatcht wird. Solche Annahmen mit einem Minimal-Experiment im echten Browser testen statt aus der Spec zu schließen.
  criterion now: ISC-17 (sandbox="allow-scripts allow-forms") + ISC-38 (Experiment-Beleg, dass das submit-Event feuert und preventDefault greift).

- conjectured: Dashboards nutzen Formulare ausschließlich über das dokumentierte Muster (submit-Handler mit preventDefault + LOKI.save) — Beispiel und Skill reichen als Leitplanke.
  refuted by: Live-Befund 2026-06-07 — agent-gebautes Fitness-Dashboard machte native Form-Submission, Sandbox blockte hart ("Blocked form submission … 'allow-forms' is not set"); Speichern ging gar nicht.
  learned: Verträge, die nur in Doku/Beispielen leben, halten agent-generierten Code nicht — die Plattform muss den häufigsten Fehlweg selbst entschärfen (Sicherheitsnetz im injizierten Helper) UND der Skill muss das Verbot explizit aussprechen.
  criterion now: ISC-36 (globales capture-phase preventDefault im Helper) + ISC-37 (explizites Skill-Verbot nativer Submission, form.submit(), autofocus).

- conjectured: Ein Save-Result darf bedingungslos quittiert werden (Toast), sobald der Schreibvorgang abgeschlossen ist.
  refuted by: Forge-Review — bei Dashboard-Wechsel mid-save erschiene der Erfolgs-Toast im Kontext des falschen, inzwischen sichtbaren Dashboards.
  learned: Asynchrone UI-Quittungen müssen an denselben Kontext-Guard gebunden sein wie die Result-Zustellung; "Operation fertig" und "Nutzer sieht noch den passenden Kontext" sind getrennte Bedingungen.
  criterion now: ISC-16 (Toast) gilt nur bei weiterhin aktivem anfragendem iframe — Toast-Aufrufe stehen im selben Guard-Block wie das Result-postMessage.

## Verification

- ISC-1..5, 12..17, 19..22: Grep-Probe — 20 Treffer über `window.LOKI = {`, `loki:save`, `loki:save:result`, `SAVE_FILENAME_RE`, `MAX_SAVE_BYTES`, `/api/file/save`, `ev.source !== iframe.contentWindow`, `sandbox', 'allow-scripts`; kein `fetch(`/`eval(`/`new Function` im Beispiel; `window.LOKI_DATA = ' + safe(rows)` weiterhin gesetzt (Zeile 265).
- ISC-6, 7, 9, 10, 11: `node -e` Unit-Probe des Sanitizers — alle 10 Fälle OK (Traversal `../`, `..\\`, `a/b.json`, `x..json`, `<script>.json`, `.txt`, leer → null; gültige Namen durchgelassen; Datum-Default + Heute-Fallback korrekt). Typ-/Größen-/date-Checks per Code-Read + Forge/Reviewer bestätigt.
- ISC-8, 20: Code-Read + Cross-Review — Ordner-Teil ausschließlich server-discovery-basiert, Dateiname whitelist-validiert, zusätzlich defensive `..`/`\`-Prüfung auf folder.
- ISC-18: `node --check loki-dashboards.js` → exit 0 ("JS OK"), nach allen Edits erneut.
- ISC-23..28: Grep-Probe — 19 Treffer über `entryForm`, `LOKI.save`, `saveBtn.disabled`, `res.rows`, Fallback-Meldung; Leerzustand-Hinweis verweist aufs Formular ("ersten Eintrag direkt unten im Formular erfassen").
- ISC-29..32: Read/Grep — SKILL.md mit Frontmatter, PFLICHT-FRAGEBLOCK (Z. 29), Frage 1 "Nur Anzeige oder auch Eingabe?" (Z. 33), beide Kontrakte + Sandbox-Regeln, `daten/`-Pflicht (Z. 59).
- ISC-33: Grep — "Zwei Schreibwege, EIN Vertrag" in dashboard-data/SKILL.md (Z. 28).
- ISC-34: Grep — `for skill in dashboard-data dashboard-builder` in setup-skills.sh (Z. 7); `sh -n` → exit 0.
- ISC-35: git log --stat — Commit e7c65cd auf main, 6 Dateien, 615 Insertions (ISA.md + Bridge + Beispiel + 2 Skills + setup-skills.sh).
- Live-E2E (Formular speichert auf hermeswebui.kimiboca.de): [DEFERRED-VERIFY] — Follow-up: `deploy-webui.sh` + `setup-skills.sh` im Container ausführen, dann Interceptor-Probe Gesundheits-Dashboard → Eintrag speichern → Datei in daten/ prüfen.
