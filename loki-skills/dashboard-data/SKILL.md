---
name: dashboard-data
description: Schreibt schemakonforme JSON-Daten in den daten/-Ordner eines Loki-Dashboards. Legt beim ersten Lauf das schema.json als verbindlichen Vertrag an und hält sich danach exakt daran. Für (geplante) Tasks, die ein Dashboard mit frischen Daten versorgen.
version: 1.0.0
platforms: [linux, macos]
metadata:
  hermes:
    tags: [dashboard, data, json, loki, cron]
    category: loki
---
# Dashboard-Daten schreiben (Loki OS)

## Wann nutzen
Immer wenn ein Task Daten für ein **Loki-Dashboard** erzeugen oder aktualisieren soll.
Der Task-Prompt nennt: das **Ziel-Dashboard** (Ordnername), die **Datenquelle/Aufgabe**
und – beim ersten Mal – die **gewünschten Felder**.

## Das Modell (Konsistenz ist alles)
Jedes Dashboard ist ein Ordner im Workspace, z.B. `research/`:
```
research/
├── schema.json        ← DER VERTRAG: welche Felder, welche Typen
├── daten/             ← ein JSON pro Lauf
│   └── 2026-06-03.json
└── dashboard.html     ← die Anzeige (baut ein ANDERER Skill; hier NICHT nötig)
```

**Regeln für die Daten — strikt einhalten:**
- **Ein Datensatz = eine Datei** `daten/<YYYY-MM-DD>.json`. Der Dateiname ist das `date`.
- Jeder Datensatz ist ein **flaches JSON-Objekt** mit **Pflichtfeld `date`** (Format `YYYY-MM-DD`)
  plus den fachlichen Feldern.
- **Schemakonform**: NUR die in `schema.json` definierten Felder, mit **korrekten Typen**
  (Zahl bleibt Zahl `8500`, nicht String `"8500"`; Arrays bleiben Arrays).
- **Valides JSON**: doppelte Anführungszeichen, kein trailing comma, UTF-8.

## Prozedur
1. **Ziel-Ordner** aus dem Task-Prompt bestimmen (z.B. `research`), relativ zum Workspace-Root.
2. **Schema prüfen/anlegen** (`<ordner>/schema.json`):
   - Existiert es → lies es und halte dich EXAKT an Felder + Typen.
   - Existiert es NICHT (erster Lauf) → lege es an als JSON-Schema:
     `{ "type":"object", "required":[...], "properties": { "date": {"type":"string"}, ... } }`
     mit `date` + allen fachlichen Feldern. **Das ist der Vertrag für ALLE künftigen Läufe** –
     spätere Läufe ändern das Schema nicht, sondern liefern dieselben Felder.
3. **`<ordner>/daten/`-Ordner** sicherstellen (anlegen falls fehlt).
4. **Daten beschaffen** gemäß Task-Prompt (WebSearch, MCP-Tools, Berechnung, …).
5. **Schreiben**: `<ordner>/daten/<heutiges-datum>.json` mit dem schemakonformen Objekt.
   `date` = heutiges Datum (`YYYY-MM-DD`). Existiert die Datei für heute schon → überschreiben
   (idempotent pro Tag).
6. **Validieren**: geschriebenes JSON ist valide, enthält alle `required`-Felder mit korrekten Typen.

## Verifikation
- `<ordner>/schema.json` existiert und ist valides JSON-Schema.
- `<ordner>/daten/<heute>.json` existiert, ist valides JSON, hat `date` + alle Schema-Felder
  mit korrekten Typen. Bei mehreren Tagen liegen mehrere Dateien nebeneinander.

## Beispiel: Daily Research
Task-Prompt: *„Recherchiere das Tagesthema X. Nutze Skill dashboard-data, Ziel-Ordner `research`."*
- Schema (erster Lauf) `research/schema.json`:
  ```json
  {
    "type": "object",
    "required": ["date", "topic", "summary", "key_points", "sources"],
    "properties": {
      "date":       { "type": "string" },
      "topic":      { "type": "string" },
      "summary":    { "type": "string" },
      "key_points": { "type": "array", "items": { "type": "string" } },
      "sources":    { "type": "array", "items": { "type": "string" } }
    }
  }
  ```
- Datensatz `research/daten/2026-06-03.json`:
  ```json
  {
    "date": "2026-06-03",
    "topic": "…",
    "summary": "…",
    "key_points": ["…", "…"],
    "sources": ["https://…"]
  }
  ```

## Hinweis Workspace
Pfade sind relativ zum Workspace-Root des Tasks. Schreibe IMMER in den Workspace, in dem auch
das Dashboard erwartet wird (gleiche Loki-OS-Instanz), damit die loki-dashboards-Extension die
Daten findet.
