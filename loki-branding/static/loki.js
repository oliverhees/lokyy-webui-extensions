/*
 * Lokyy OS — Loki Branding Extension für Hermes WebUI (nesquena/hermes-webui)
 * --------------------------------------------------------------------------
 * White-Label "Hermes" → "Loki OS". Rein additiv, kein Core-Fork.
 *
 * Was sie tut:
 *   1. <title> auf 'Loki OS' setzen (Browser-Tab).
 *   2. #appTitlebarTitle textContent auf 'Loki OS' setzen (sichtbarer App-Titel).
 *   3. data-skin="loki" auf <html> setzen → aktiviert loki.css (Akzent-Palette).
 *
 * WARUM der MutationObserver ZWINGEND ist (realer Threat, kein belt-and-suspenders):
 *   Das wirklich gefährdete Element ist NICHT der Titel — es ist das Skin.
 *
 *   boot.js des Hosts kennt 'loki' nicht: 'loki' fehlt in _VALID_SKINS
 *   (Set aus _SKINS: default, ares, mono, slate, poseidon, sisyphus,
 *   charizard, sienna, catppuccin, hepburn, nous, neon, geist-contrast —
 *   verifiziert in boot.js @ master, Z.1454-1470). Folge:
 *     - _normalizeAppearance(theme, skin) gibt für skin='loki' → 'default'
 *       zurück (nextSkin = _VALID_SKINS.has(rawSkin) ? rawSkin : 'default';
 *       boot.js Z.1486).
 *     - _applySkin('default') führt aus (boot.js Z.1550):
 *           if (key === 'default') delete document.documentElement.dataset.skin;
 *       → es LÖSCHT unser data-skin='loki' deterministisch von <html>.
 *
 *   Das passiert ZWEIMAL:
 *     (a) synchron während boot.js-Init, und
 *     (b) erneut ASYNCHRON nach GET /api/settings (async IIFE in boot.js:
 *         await api('/api/settings') Z.1666 → _applySkin(skin) Z.1747),
 *         d.h. typischerweise hunderte Millisekunden nach Page-Load — lange
 *         nachdem unsere Erstanwendung gelaufen ist.
 *
 *   Deshalb MUSS der Observer die ATTRIBUTE von document.documentElement
 *   beobachten (attributeFilter: ['data-skin']) und data-skin='loki' jedes
 *   Mal RE-ASSERTEN, sobald es divergiert. Ohne diese Beobachtung bleibt das
 *   Entfernen von data-skin unentdeckt → die gesamte CSS-Hälfte der Extension
 *   (Teal-Akzentpalette + Logo-Recolor) wird kurz nach Page-Load zuverlässig
 *   abgestreift.
 *
 *   Der Titel überlebt ohne Observer, weil boot.js <title> und
 *   #appTitlebarTitle nie anfasst — der Observer auf head/title/body ist dort
 *   nur Vorsorge gegen i18n-/Re-Render-Effekte (#appTitlebarTitle trägt kein
 *   data-i18n, index.html Z.139). Der KRITISCHE Job des Observers ist die
 *   data-skin-Re-Assertion auf <html>.
 *
 * Loop-Sicherheit:
 *   Es gibt KEIN "applying"-Fenster und KEINEN Guard, der eigene Writes
 *   ausblendet. Der EINZIGE Loop-Breaker ist Idempotenz: applyBranding()
 *   schreibt ausschließlich bei echter Divergenz (title/textContent/dataset
 *   weichen vom Soll ab). Ein Write, der nichts ändert, löst keinen weiteren
 *   MutationRecord aus → keine Endlosschleife.
 *
 * Verifizierte Selektoren/Attribute (gegen static/index.html + static/boot.js +
 * THEMES.md (Repo-Root) @ master):
 *   - <span class="app-titlebar-title" id="appTitlebarTitle">Hermes</span>
 *     (index.html Z.139)
 *   - <title>Hermes</title> (index.html Z.6)
 *   - Skin-Contract: document.documentElement.dataset.skin = '<name>'
 *     (THEMES.md Z.145)
 *   - boot.js: _applySkin('default') → delete documentElement.dataset.skin
 *     (boot.js Z.1550)
 *   - boot.js: _VALID_SKINS enthält 'loki' NICHT → /api/settings clobbert async
 *     (boot.js Z.1470, Z.1747)
 *   - no-flash inline script (index.html ~Z.20): skins-Allowlist ohne 'loki'
 *     → der Host persistiert das Skin nie; einzige Quelle der Wahrheit für
 *       data-skin='loki' ist DIESE Extension (Re-Assert unten).
 */
(() => {
  'use strict';

  // Idempotenz-Guard gegen Doppel-Injektion.
  if (window.__lokiBrandingLoaded) return;
  window.__lokiBrandingLoaded = true;

  const BRAND = 'Loki OS';
  const TITLE_ID = 'appTitlebarTitle'; // verifiziert in index.html Z.139
  const SKIN = 'loki';

  function applyBranding() {
    // (1) Browser-Tab-Titel — nur schreiben bei Divergenz (Idempotenz).
    if (document.title !== BRAND) {
      document.title = BRAND;
    }

    // (2) Sichtbarer App-Titel in der Titlebar (robust gegen fehlendes Element).
    const titleEl = document.getElementById(TITLE_ID);
    if (titleEl && titleEl.textContent !== BRAND) {
      titleEl.textContent = BRAND;
    }

    // (3) Skin RE-ASSERTEN. boot.js löscht data-skin async nach /api/settings
    //     (siehe Header). documentElement existiert immer; dataset.skin
    //     akzeptiert serverseitig "any string". Wir sind die EINZIGE Quelle
    //     der Wahrheit für data-skin='loki'.
    const root = document.documentElement;
    if (root && root.dataset.skin !== SKIN) {
      root.dataset.skin = SKIN;
    }
  }

  // ── Re-Apply: Schnellpfad (sofort) + Debounce (Sammelpfad) ────────────────
  //
  // Loop-Sicherheit kommt allein aus der Idempotenz von applyBranding (schreibt
  // nur bei Divergenz). Es gibt KEINEN "applying"-Guard, der ein externes
  // data-skin-Removal verschlucken könnte.
  let pending = null;
  function scheduleApply() {
    if (pending) return;           // bereits geplant → debounce
    pending = setTimeout(() => {
      pending = null;
      applyBranding();
    }, 60);
  }

  // Erstanwendung sofort.
  applyBranding();

  // ── Observer aufsetzen ────────────────────────────────────────────────────
  function startObserver() {
    const observer = new MutationObserver((records) => {
      // Schnellpfad: Wenn boot.js gerade data-skin von <html> entfernt/geändert
      // hat, sofort re-asserten — NICHT erst nach dem 60ms-Debounce. Das hält
      // das CSS-Skin auch bei aggressivem Clobber lückenlos aktiv.
      for (const rec of records) {
        if (
          rec.type === 'attributes' &&
          rec.attributeName === 'data-skin' &&
          rec.target === document.documentElement &&
          document.documentElement.dataset.skin !== SKIN
        ) {
          applyBranding(); // idempotent → setzt data-skin='loki' zurück, ohne Loop
          return;          // erledigt; Sammelpfad nicht zusätzlich nötig
        }
      }
      // Alle übrigen Records (Titel-Re-Renders, head/body-Mounts) gebündelt.
      scheduleApply();
    });

    // (A) KRITISCH: Attribute der Wurzel beobachten, um boot.js'
    //     `delete document.documentElement.dataset.skin` zu erkennen und
    //     data-skin='loki' wieder zu setzen.
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-skin'],
    });

    // (B) Vorsorge gegen Titel-Re-Renders (i18n / dynamische Mounts).
    const titleEl = document.getElementById(TITLE_ID);
    if (titleEl) {
      observer.observe(titleEl, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    const head = document.head;
    if (head) {
      observer.observe(head, { childList: true, subtree: true });
    }

    // Sicherheitsnetz: wenn der Titel-Knoten beim Start fehlte, beobachte den
    // body, um ihn nach dem Mount nachträglich zu branden.
    if (!titleEl && document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    window.__lokiBrandingObserver = observer; // für Debugging/Teardown
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      applyBranding();
      startObserver();
    }, { once: true });
  } else {
    startObserver();
  }
})();
