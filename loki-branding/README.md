# Loki Branding — Hermes WebUI Extension

White-Label für `nesquena/hermes-webui`: macht aus **„Hermes"** das **„Loki OS"** — neuer App-Titel, neuer Browser-Tab-Titel und ein eigenes, markantes Smaragd/Teal-Akzent-Skin. Rein additiv, kein Core-Fork.

## Was sie tut

1. **Browser-Tab-Titel** → `Loki OS` (`<title>`).
2. **Sichtbarer App-Titel** in der Titlebar → `Loki OS` (`#appTitlebarTitle`).
3. **Eigenes Skin** `data-skin="loki"` auf `<html>` → aktiviert die Loki-Akzent-Palette aus `loki.css` (Light- und Dark-Variante).
4. **Dezente Logo-Anpassung** (optional): färbt den Gold-Gradient des Caduceus-Logos auf Loki-Teal um.

Ein **MutationObserver** hält das Branding aktiv. Sein **kritischer** Job ist die Re-Assertion von `data-skin="loki"` auf `<html>`: Der Host kennt `loki` nicht (`loki` fehlt in `_VALID_SKINS`, boot.js Z.1470), und `_applySkin('default')` löscht `data-skin` nach jedem `/api/settings`-Load wieder (`delete document.documentElement.dataset.skin`, boot.js Z.1550) — synchron beim Boot und erneut asynchron nach `await api('/api/settings')` (Z.1666/1747). Der Observer beobachtet `attributeFilter: ['data-skin']` und setzt `loki` per **Schnellpfad sofort** zurück, sobald der Wert divergiert (ohne auf den 60-ms-Debounce zu warten). Für Titel-Re-Renders nutzt er einen gebündelten **Debounce**-Pfad. Endlosschleifen sind ausgeschlossen, weil der einzige Loop-Breaker **Idempotenz** ist: `applyBranding()` schreibt ausschließlich bei echter Divergenz, ein Write ohne Änderung erzeugt keinen weiteren `MutationRecord`. Die Titel-Beobachtung ist **defensiv** (der Span `#appTitlebarTitle` trägt kein `data-i18n`, ebensowenig `<title>` — i18n überschreibt sie nicht direkt); die `data-skin`-Re-Assertion dagegen ist zwingend nötig.

- **Kein Fork.** Nutzt das offizielle Extension-System (`HERMES_WEBUI_EXTENSION_*`) und den dokumentierten Skin-Contract aus `THEMES.md` (Repo-Root).
- **Überlebt Upstream-Updates** (additiv, kein Core-Patch).

## Dateien

```
static/loki.css     ← das "loki"-Skin (Akzent-Palette Light + Dark) + Logo-Tint
static/loki.js      ← Titel-/Skin-Logik (IIFE, idempotent, MutationObserver)
```

## Installation — generisch (lokal / VPS)

Analog zur `mcp-manager`-Extension: Dateien ins Extension-Dir legen, ENV-Variablen ergänzen, WebUI neu starten.

```bash
# 1. Extension-Dateien an einen festen Ort legen (NICHT user-writable für Fremde)
mkdir -p ~/.hermes/webui-extension
cp static/loki.js static/loki.css ~/.hermes/webui-extension/

# 2. ENV-Variablen setzen, BEVOR die WebUI startet
export HERMES_WEBUI_EXTENSION_DIR=~/.hermes/webui-extension
export HERMES_WEBUI_EXTENSION_SCRIPT_URLS=/extensions/loki.js
export HERMES_WEBUI_EXTENSION_STYLESHEET_URLS=/extensions/loki.css

# 3. WebUI neu starten
```

**Schon mehrere Extensions aktiv?** URLs einfach kommagetrennt anhängen (Reihenfolge = Lade-Reihenfolge):

```bash
export HERMES_WEBUI_EXTENSION_SCRIPT_URLS=/extensions/mcp-manager.js,/extensions/loki.js
export HERMES_WEBUI_EXTENSION_STYLESHEET_URLS=/extensions/mcp-manager.css,/extensions/loki.css
```

## Installation — Coolify

1. **Persistent Storage** (Coolify → hermes-webui-Resource → *Storages*): Mount-Path z.B. `/extensions-src` (überlebt Redeploys).
2. **Dateien dort ablegen:** `loki.js` + `loki.css` ins gemountete Volume kopieren.
3. **Environment Variables** ergänzen:
   ```
   HERMES_WEBUI_EXTENSION_DIR=/extensions-src
   HERMES_WEBUI_EXTENSION_SCRIPT_URLS=/extensions/loki.js
   HERMES_WEBUI_EXTENSION_STYLESHEET_URLS=/extensions/loki.css
   ```
4. **Redeploy / Restart** der Resource.

> Der genaue Mount-Path hängt vom Image ab (Standard-State bei `nesquena/hermes-webui` unter `/home/hermeswebui/.hermes/`). Wenn unklar, gemeinsam am echten Container verifizieren.

## Anpassbar

- **Farben:** Alle fünf Akzent-Variablen (`--accent`, `--accent-hover`, `--accent-bg`, `--accent-bg-strong`, `--accent-text`) stehen jeweils für Light und Dark oben in `loki.css`. Hex-Werte einfach überschreiben — kein JS anfassen nötig. Default ist tiefes Smaragd/Teal `#1f9e7a` (Light) bzw. `#2fc79b` (Dark) als Vorschlag; final von Oliver justierbar.
- **Logo:** Der dezente Teal-Tint des Caduceus-Logos sitzt am Ende von `loki.css` und ist reine Kosmetik — entfernbar, falls das originale Gold-Logo bevorzugt wird. Das Logo-SVG nutzt **hartkodierte** Gold-Stops (`#F5C542`/`#D4961C`) als **Inline-`style="stop-color:..."`** direkt im Markup, weshalb der Tint per CSS auf die SVG-Gradient-IDs `#app-titlebar-gold` und `#hermes-gold` zielt. **Wichtig:** Da Inline-Styles im Cascade-Origin gegen normale Stylesheet-Regeln gewinnen (unabhängig von der Spezifität), müssen die Tint-Regeln zwingend `!important` tragen — sonst bliebe das Logo gold. Genau so ist es in `loki.css` umgesetzt (in echtem Chrome verifiziert: computed stop-color `rgb(63,212,166)`/`rgb(21,122,93)`).
- **Markenname:** `BRAND`-Konstante in `loki.js` ändern, falls statt „Loki OS" ein anderer Name gewünscht ist.

## Verifizierte Hooks (gegen `nesquena/hermes-webui` @ master)

| Hook | Quelle |
|------|--------|
| `<span class="app-titlebar-title" id="appTitlebarTitle">Hermes</span>` | `static/index.html` (Z.139) |
| `<title>Hermes</title>` | `static/index.html` (Z.6) |
| Skin-Contract: `:root[data-skin="loki"]` + `:root.dark[data-skin="loki"]` | `THEMES.md` (Repo-Root, Z.75 + Z.84) |
| Akzent-Vars: `--accent --accent-hover --accent-bg --accent-bg-strong --accent-text` | `THEMES.md` (Repo-Root, Z.76–80 Light; `--accent-bg-strong` zusätzlich Z.88 Dark) |
| Skin setzen: `document.documentElement.dataset.skin = name` | `THEMES.md` (Repo-Root, Z.145) |
| Dark-Modus: `.dark`-Klasse auf `<html>` | `THEMES.md` (Repo-Root, Z.84/107) |
| Logo-Gradient-IDs: `#app-titlebar-gold`, `#hermes-gold` | `static/index.html` (Z.128, Z.382) |
| ENV: `HERMES_WEBUI_EXTENSION_DIR` / `_SCRIPT_URLS` / `_STYLESHEET_URLS` | `docs/EXTENSIONS.md` |

> **Hinweis zu `THEMES.md`:** Die Datei liegt im **Repo-Root** (`THEMES.md`, ~170 Zeilen) — **nicht** unter `docs/`. (`docs/EXTENSIONS.md` liegt dagegen wirklich unter `docs/`.) Der Skin-Selektor ist `:root[data-skin="..."]` (Light) **und** `:root.dark[data-skin="..."]` (Dark) — nicht nur ein einzelner `[data-skin]`-Block. Außerdem gehört `--accent-bg-strong` nachweislich zum vollständigen Akzent-Contract (5 Variablen, nicht 4): Die Variable steht im offiziellen Skin-Beispiel von `THEMES.md` in Z.79 (Light, „Highlighted backgrounds") und Z.88 (Dark). Beides ist in `loki.css` korrekt umgesetzt.

## Sicherheit

Extensions laufen mit voller Session-Autorität (Trust-Modell des Extension-Systems). Nur Extensions aus eigener/vertrauter Quelle aktivieren. `HERMES_WEBUI_EXTENSION_DIR` nicht auf ein für Fremde beschreibbares Verzeichnis zeigen lassen. WebUI-Passwortschutz aktiv lassen.

---
*Teil von `lokyy-webui-extensions` · erstellt mit Alice für Lokyy OS / KIMIBOCA.*
