# Design — Settings-Fenster auf Tabs umbauen

Branch: `main`
Status: **IMPLEMENTED** (v0.33.0) — reiner View-Umbau, kein Schema-Change.
Milestone: **M82** (shipped before the larger DSO feature, which becomes M83).

---

## 1. Problem

Das Settings-Modal (`web/index.html` ab Zeile 508) ist heute **eine einzige,
sehr lange Zwei-Spalten-Wand** aus Fieldsets in einem scrollenden Dialog:

- Links: Observer · Telescope &amp; sensor · Pushover · Audio/Buzzer
- Rechts: Tracker · AirNav Radar API · SharpCap capture trigger · E-paper

Der Buzzer-Block allein hat ~40 Felder (6 Signal-Gruppen). Man scrollt endlos,
verliert den Überblick, und die feste Zwei-Spalten-Aufteilung verschenkt
Breite. → **Logische Tabs** statt eines Riesen-Scrollbalkens.

## 2. Ziel

Die Fieldsets in **thematische Tabs** umgruppieren. Pro Tab nur dessen Felder,
volle Dialogbreite nutzbar (mehrspaltiges Grid je Tab statt globaler 2 Spalten),
kein seitenlanges Scrollen mehr.

## 3. Tab-Aufteilung (Vorschlag)

| Tab | Enthält (heutige Fieldsets) |
|---|---|
| **General** | Observer · Telescope &amp; sensor (FOV-Optik) · Tracker |
| **Scopes** | SharpCap capture trigger (Global defaults · Main rig · Capture rigs) |
| **Pushover** | Pushover |
| **Sounds** | Audio / Buzzer (alle Signal-Gruppen) |
| **E-paper** | E-paper display |
| **Data** | AirNav Radar API (+ ADS-B-Quelle, OpenSky, falls künftig in der UI) |
| *(später)* **Sky targets** | DSO/Stern/Planet-Ziele aus `dso-iss-path-prediction.md` |

Reihenfolge der Tabs nach Nutzungshäufigkeit: General zuerst (Standort/Optik
richtet man als Erstes ein), dann Scopes, Pushover, Sounds, E-paper, Data.
„Sky targets" wird ein eigener Tab, sobald jenes Feature kommt — die Tab-Leiste
ist dafür der natürliche Erweiterungspunkt.

## 4. Warum das risikoarm ist (wichtig)

Das Formular wird in `web/app.js` **ausschließlich über `name`-Attribute**
befüllt und serialisiert (`settingsForm.elements[...]`, Zeilen 1877 / 1918).
Die DOM-**Verschachtelung** spielt für Speichern/Laden **keine Rolle** —
solange jeder Input

1. sein `name`-Attribut behält und
2. im selben `<form id="settings-form">` bleibt,

ändert sich an Validierung, `/api/config`-POST und Hot-Reload **nichts**.
→ Reiner **HTML/CSS/JS-View-Umbau**, **keine** Server- oder Config-Schema-
Änderung. Die Fieldsets werden nur in Tab-Container umgehängt.

## 5. Umsetzung

### Markup
- Innerhalb von `<form id="settings-form">` eine **Tab-Leiste**
  (`role="tablist"`) + ein **Panel pro Tab** (`role="tabpanel"`, alle außer
  dem aktiven `hidden`). Die bestehenden `<fieldset>`-Blöcke werden 1:1 in das
  passende Panel verschoben (kein Inhalt umschreiben).
- Buttons der Leiste: `role="tab"`, `aria-selected`, `aria-controls`,
  `data-tab="general|scopes|pushover|sounds|epaper|data"`.
- Die globale `.settings-fields` / `.settings-col`-Zweispaltigkeit entfällt;
  jedes Panel bekommt bei Bedarf sein **eigenes** responsives Grid
  (z. B. Sounds: mehrspaltiges Raster der Signal-Gruppen, jetzt wo Breite frei
  ist).

### JS (`web/app.js`)
- Kleiner Tab-Switcher: Klick/Tastatur (←/→, Home/End) schaltet aktives Panel,
  setzt `aria-selected`/`hidden`. Default-Tab beim Öffnen = **General**.
- **Validierungs-Sichtbarkeit:** Schlägt das Server-Validate für ein Feld fehl,
  muss der **Tab dieses Feldes automatisch aktiviert** und das Feld fokussiert
  werden — sonst zeigt die Fehlermeldung auf ein verstecktes Panel. (Mapping
  Feld→Tab aus der Gruppierung ableiten.)
- Bestehende Button-Hooks (Buzzer-Test, SharpCap-Test, „+ Add rig") bleiben
  unverändert — sie hängen an IDs, nicht an der Position.
- **Save/Cancel-Leiste** (`.settings-actions`) bleibt **außerhalb** der Tabs,
  fix am Dialogfuß — ein Save speichert immer **alle** Tabs (ein Formular).

### CSS (`web/style.css`)
- `.settings-tablist` (horizontale Buttonleiste, aktiver Tab hervorgehoben,
  umbruchfähig/scrollbar auf schmalen Viewports).
- `.settings-tabpanel[hidden]` aus dem Flow; aktives Panel als eigenes Grid.
- Dialog ggf. etwas breiter, da Tabs die Höhe begrenzen und Breite nutzbar
  machen.

## 6. UX-Details

- **Ein Save für alles:** Tabs sind nur eine Ansicht; gespeichert wird das
  ganze Formular — kein Tab-weises Speichern (vermeidet Teil-Speicher-Verwirrung).
- **Unsaved-Hinweis** (optional, nice-to-have): geänderte Tabs markieren, damit
  man vor dem Schließen nichts übersieht.
- **Tab-Persistenz** (optional): zuletzt aktiven Tab in `localStorage` merken,
  damit man beim erneuten Öffnen dort landet.
- **Mobile:** Tabs als horizontal scrollbare Leiste; ein Panel pro Bildschirm
  ist auf dem Handy ohnehin besser als die heutige Doppelspalte.

## 7. Plan (nach Freigabe)

- [x] `index.html`: Tablist + `data-tab`-Fieldsets in `#settings-form`; statt die
      Fieldsets physisch umzuhängen, trägt jedes ein `data-tab` und der Switcher
      blendet pro Tab ein/aus (Inhalt/`name` 1:1 unverändert, geringeres Risiko).
- [x] `app.js`: Tab-Switcher (Maus + Tastatur ←/→/Home/End, ARIA roving-tabindex);
      Default = General mit `localStorage`-Persistenz; `settingsFieldForError()`
      springt bei Validierungsfehler auf den Tab des Feldes + fokussiert es.
- [x] `style.css`: `.settings-tablist` (sticky), `.settings-tab`; `auto-fit`-Grid
      blendet versteckte Fieldsets aus und füllt Einzel-Tab voll, General 2-spaltig.
- [x] Smoke-Test: HTML serviert mit 6 Tabs + 8 zugeordneten Fieldsets (general=3,
      Rest je 1), keine `settings-col`-Reste; name-basiertes Save/Load unverändert;
      Buzzer-/SharpCap-Test + „+ Add rig" hängen an IDs (unberührt).
- [x] MILESTONES: M82 (Settings-Tabs, reiner View-Umbau, kein Schema-Change).

**Umsetzungs-Notiz:** Statt „Tabpanels mit umgehängten Fieldsets" (Design §5) wurde
der risikoärmere `data-tab`-Ansatz gewählt — kein Fieldset bewegt sich im DOM, nur
ein Attribut pro Block + Show/Hide. Ergebnis identisch, Diff minimal.

## 8. Nicht-Ziele

- **Keine** Änderung an Config-Schema, `/api/config`, Validierung oder
  Feldsemantik. Felder werden nur **umgruppiert**, nicht umbenannt/entfernt.
- Keine inhaltliche Überarbeitung einzelner Felder (separat, falls gewünscht).

## 9. Offene Fragen

- Tab-Set wie oben (General/Scopes/Pushover/Sounds/E-paper/Data) ok, oder
  „Tracker" als eigener Tab statt unter „General"?
- „Sky targets"-Tab schon jetzt als leeres Gerüst anlegen oder erst mit dem
  Feature aus `dso-iss-path-prediction.md`?
- Tab-Persistenz (localStorage) gewünscht oder bewusst immer mit General starten?
