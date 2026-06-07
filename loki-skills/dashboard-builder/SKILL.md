---
name: dashboard-builder
description: Baut die dashboard.html eines Loki-Dashboards — self-contained HTML im Loki-Dark-Theme, das Daten aus window.LOKI_DATA liest und optional per LOKI.save() Formulareingaben zurück in den Workspace schreibt. Klärt VOR dem Bau verbindlich, ob und welche Eingabemöglichkeiten gebraucht werden.
version: 1.0.0
platforms: [linux, macos]
metadata:
  hermes:
    tags: [dashboard, html, form, write-back, loki]
    category: loki
---
# Dashboard bauen (Loki OS)

## Wann nutzen
Immer wenn ein neues **Loki-Dashboard** (die `dashboard.html`) gebaut oder ein bestehendes
erweitert werden soll. Datenbeschaffung ist NICHT Teil dieses Skills — das macht der
Schwester-Skill `dashboard-data` (und/oder ein Formular im Dashboard selbst, siehe unten).

## Das Modell
Jedes Dashboard ist ein Ordner im Workspace, z.B. `gesundheit/`:
```
gesundheit/
├── schema.json        ← DER VERTRAG: welche Felder, welche Typen (gilt für ALLE Schreibwege)
├── daten/             ← ein JSON pro Datensatz, Pflichtfeld 'date' (YYYY-MM-DD)
└── dashboard.html     ← die Anzeige (+ optionales Eingabe-Formular) — DAS baut dieser Skill
```
Die loki-dashboards-Extension entdeckt jeden Ordner mit `dashboard.html`, lädt die
`daten/*.json` parent-seitig und injiziert sie ins sandboxed iframe.

## 🚨 PFLICHT-FRAGEBLOCK — VOR dem Bau klären
**Baue NIEMALS los, bevor diese Fragen beantwortet sind.** Stelle sie dem Nutzer im Chat,
sofern der Task-Prompt sie nicht bereits eindeutig beantwortet:

1. **Nur Anzeige oder auch Eingabe?**
   "Soll man in diesem Dashboard auch etwas eintragen können (Formular), oder zeigt es nur an?"
2. **Falls Eingabe — welche Felder?**
   Pro Feld: Name (snake_case), Typ (Zahl/Text/Datum/Liste), Pflicht oder optional,
   sinnvolle Grenzen (z.B. Blutdruck systolisch 60–260). Felder MÜSSEN zum `schema.json`
   passen — existiert noch keins, wird es aus den Antworten angelegt.
3. **Falls Eingabe — wie oft wird eingetragen?**
   - Ein Eintrag pro Tag → Datei `<date>.json` (Default; gleicher Tag überschreibt, idempotent)
   - Mehrere Einträge pro Tag → Dateiname mit Suffix, z.B. `<date>_morgens.json`
     (per `LOKI.save(record, {file: ...})`)
4. **Welche Auswertung soll die Anzeige zeigen?**
   Kennzahl-Karten (welche?), Verlauf/Sparkline (welches Feld?), Tabelle, Zeitraum.

Erst wenn 1–4 geklärt sind: bauen.

## Bau-Regeln (strikt)
- **Self-contained**: reines HTML + CSS + JS in EINER Datei. KEINE externen Libs/CDN
  (das iframe ist offline-sandboxed). Charts als Inline-SVG.
- **Kein fetch, kein XMLHttpRequest, kein eval** — das iframe hat keinen API-Zugriff
  (sandbox ohne allow-same-origin, harte Browser-Grenze). Lesen NUR aus `window.LOKI_DATA`,
  Schreiben NUR über `window.LOKI.save()`.
- **Formulare: NIEMALS native Submission.** Die Sandbox hat KEIN `allow-forms` — ein
  natives Form-Submit wird vom Browser hart geblockt ("Blocked form submission …
  sandboxed"). Verbindlich:
  - `submit`-Handler MUSS als erste Zeile `ev.preventDefault()` aufrufen, danach
    `LOKI.save(...)` (siehe Minimalmuster unten).
  - **NIEMALS `form.submit()` programmatisch aufrufen** — das feuert kein submit-Event,
    umgeht jeden Handler und wird geblockt. Stattdessen `form.requestSubmit()` oder den
    Handler direkt aufrufen.
  - Kein `action`-/`method`-Attribut am `<form>` nötig — es wird nie nativ abgeschickt.
  - Kein `autofocus`-Attribut verwenden (wird im Sandbox-iframe geblockt, erzeugt nur
    Konsolen-Fehler).
  Die Extension preventDefaultet native Submissions zusätzlich global als Sicherheitsnetz —
  darauf verlassen darf sich ein Dashboard aber nicht.
- **Dark Theme**: Hintergrund `#0b0d16`, Panels `#14161f`, Border `#2a2d3a`,
  Text `#e8e8ee`, Muted `#9aa0b4`, Akzent Orange `#F97316`.
- **Alle Nutzerdaten escapen** (esc()-Helper) — Datensätze können beliebigen Text enthalten.
- **Leerzustand**: ohne Daten klaren Hinweis zeigen, NIE weiße Seite. Hat das Dashboard ein
  Formular, bleibt das Formular auch ohne Daten nutzbar (erster Eintrag muss möglich sein).
- **`daten/`-Ordner beim Bau IMMER anlegen** (auch wenn noch leer) — `/api/file/save` legt
  fehlende Ordner nicht verlässlich an; ohne den Ordner schlägt der erste Formular-Save fehl.
- **Referenz-Vorlage**: `loki-dashboards/examples/gesundheit/dashboard.html` im
  Extensions-Repo — Aufbau, Kommentare und Formular-Pattern von dort übernehmen.

## Lese-Kontrakt (von der Extension injiziert)
- `window.LOKI_DATA` → Array aller Datensätze aus `daten/*.json`, nach `date` sortiert.
- `window.LOKI_DASHBOARD` → `{ folder, count }` (Meta, optional).
- `window.LOKI.data` / `window.LOKI.dashboard` → Aliasse auf die beiden obigen.

## Schreib-Kontrakt (Write-Back, von der Extension injiziert)
- `window.LOKI.save(record, {file?})` → **Promise**.
  - `record`: flaches JSON-Objekt, schemakonform (Zahl als Zahl, nicht als String!).
    Fehlendes `date` ergänzt die Extension mit dem heutigen Datum.
  - `file` (optional): Dateiname `^[A-Za-z0-9._-]+\.json$`. Default `<date>.json`.
  - resolved mit `{ok:true, file, path, rows}` — `rows` = ALLE frisch geladenen
    Datensätze → damit direkt neu rendern (Live-Update ohne Reload).
  - rejected mit Error (Validierungsfehler, API-Fehler, 10s-Timeout).
- Die Extension validiert hart: nur `daten/` des aktiven Dashboards, nur `.json`,
  max. 256 KB. Das Dashboard muss sich darauf nicht verlassen, aber darf es auch
  nicht umgehen wollen.
- **Fallback-Pflicht**: existiert `window.LOKI?.save` nicht (veraltete Extension),
  Formular deaktivieren + Hinweis zeigen — niemals stumm wegbrechen.

### Formular-Minimalmuster
```js
form.addEventListener('submit', function (ev) {
  ev.preventDefault();
  var record = { date: dateInput.value, systolisch: Number(sysInput.value) };
  saveBtn.disabled = true;
  window.LOKI.save(record).then(function (res) {
    saveBtn.disabled = false;
    msg.textContent = 'Gespeichert: ' + res.file;
    if (Array.isArray(res.rows)) render(res.rows);   // Charts live aktualisieren
  }).catch(function (err) {
    saveBtn.disabled = false;
    msg.textContent = String(err.message || err);
  });
});
```

## Prozedur
1. **Pflicht-Frageblock** abarbeiten (siehe oben). Antworten festhalten.
2. **`schema.json` prüfen/anlegen** — bei Formular-Feldern: Schema und Formular müssen
   exakt dieselben Felder + Typen tragen (ein Vertrag, zwei Schreibwege).
3. **`daten/`-Ordner anlegen** falls er fehlt.
4. **`dashboard.html` bauen** nach den Bau-Regeln (Vorlage: gesundheit-Beispiel).
5. **Selbst prüfen**: Leerzustand OK? esc() überall? Kein fetch/CDN? Formular (falls
   vorhanden) nutzt LOKI.save mit disabled-State, Erfolgs- UND Fehlermeldung, re-render
   aus `res.rows`? Fallback bei fehlendem LOKI.save?

## Verifikation
- `<ordner>/dashboard.html` existiert, ist self-contained (kein `http`-Verweis auf Libs).
- Bei Eingabe-Dashboards: Formularfelder == `schema.json`-Felder (Namen + Typen).
- `<ordner>/daten/` existiert.
- Dashboard erscheint nach "⟳ Aktualisieren" in der Dashboards-Liste der WebUI.
