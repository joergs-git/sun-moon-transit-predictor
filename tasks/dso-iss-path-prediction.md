# Design — ISS-Bahn durch/neben beliebige Zielobjekte (Sterne · Planeten · DSO)

Branch: `main`
Status: **IMPLEMENTED** (v0.34.0) — Phasen 1–4 gebaut & gepusht; nur die
Pushover-Plan-Alerts (§12) stehen noch aus.
Milestone: **M83** (M82 ging an die Settings-Tabs, die zuerst landeten).

**Umsetzungs-Stand (2026-06-12):**
- ✅ Geometrie (`geometry.js`): Planeten, RA/Dec via DefineStar, `apparentDiameterDeg`.
- ✅ Predictor (`iss.js` `predictSkyTargetTransits`): FOV-Treffer als **Kreis**
  (Miss ≤ Feldradius, rotationsagnostisch — die offene PA-Frage so gelöst),
  transit/field-Klassifikation, Nacht-Gates, objektzentrierte `transitPath`,
  Sat-State-Memoization für Performance.
- ✅ Service (`service.js`): `iss.skyTargets`-Config, Predictor über alle
  Satelliten × Ziele, `state.skyTargetPlan` (`skyplan.js` merge + Konfidenz +
  Konflikt), Settings-Tab „Sky targets" (Enable + Gates, validiert/persistiert).
- ✅ Katalog (`skycatalog.js`): ~44 Objekte, hellste Sterne + größte/hellste
  DSO Nord+Süd + Planeten. **Kuratiert mitgeliefert** (offene Frage so gelöst).
- ✅ Timeline-Panel oben im Haupt-View (🟢🟡🟠🔴, Konflikt-⚠, Schatten-🌑).
- ✅ Active-Target: „🔭 Scope target"-Pulldown oben → treibt den SharpCap-Trigger
  (`armForSkyTarget`, separater Pfad; Aircraft-Pfad unangetastet). Operator-State
  persistiert via `/api/active-target`. **Vorerst ein globales Active-Target**
  (nicht per-Rig) — deckt den Haupt-/Single-Rig-Fall; per-Rig = spätere Option.
- ✅ **Pushover-Plan-Alerts (§12, v0.35.0):** edge-getriggert (einmal pro Event,
  +1 bei amber→green-Upgrade), neustart-fester Fuzzy-Dedup (`sky_plan_alerts`-
  Tabelle, Match auf `(satTag,objectId)` ±5 min). Config `iss.skyTargets.
  planAlerts` + Settings-Felder im „Sky targets"-Tab.
- ⏳ **Offen (kleinere Follow-ups):** UI-Katalog-Editor (aktuell via
  `service.json`), per-Rig-Active-Target (aktuell ein globales), „Plan geändert"-
  Push wenn ein grün gemeldetes Event wieder wegfällt (offene Frage §12).

---

## 1. Ziel (umformuliert nach Rücksprache mit dem User)

Den Transit-Predictor von **Sonne/Mond** auf **beliebige Himmelsobjekte**
erweitern, gegen die die ISS (und HST/CSS) fotografiert werden soll:
Sterne (Vega, Capella …), Planeten (Jupiter, Saturn, Mars, Venus), Deep-Sky
(M13, M42/Orion …).

Der entscheidende Perspektivwechsel gegenüber dem Sonne/Mond-Fall:

> **Es gibt kein „passt die Belichtung zusammen"-Problem mehr.** Hintergrund
> und Flugobjekt werden **entkoppelt** aufgenommen und hinterher überlagert.
> Das einzige Deliverable des Predictors ist die **exakt bestimmte Relativ-
> Bahn der ISS durch/neben das gerahmte Zielfeld plus der Auslöse-Zeitpunkt.**

### Entkoppelter Aufnahme-Workflow (Vorgabe des Users)

| Ebene | Aufnahme | Zeitkritisch? |
|---|---|---|
| Hintergrund (DSO/Stern/Planet) | Langzeit-Belichtung + Stacking | nein, läuft eigenständig |
| Flugobjekt (ISS) | Lucky-Imaging-Burst, real zählt **ein** Frame | **ja**, ms-genau |

Beide werden getrennt prozessiert und im Post zu einem Bild kombiniert. Der
Predictor steuert/triggert **nur den ISS-Burst** — die DSO-Acquisition ist
nicht Teil dieses Projekts.

### Was sich am Endergebnis ändert

Bei Sonne/Mond ist das Ereignis eine **Silhouette auf einer hellen Scheibe**.
Bei einem Punkt-/DSO-Ziel ist das Ergebnis die **erkennbare ISS** (Punkt/
kurze Spur) an einer **präzise vorhergesagten Position** relativ zum Objekt.
Dass Capella/Vega nur leuchtende Punkte sind, ist unkritisch — Hauptsache die
Bahn (durch das Objekt oder mit definiertem Abstand daneben) steht exakt fest.

---

## 2. Zwei Ereignisklassen, ein vereinheitlichtes Modell

| | A — Scheiben-Transit | B — Bahn-durch-Feld |
|---|---|---|
| Ziel | Sonne, Mond, **Planeten** (echte Scheibe) | Sterne, **DSO**, (Planeten als Punkt) |
| Ereignis | ISS-Silhouette quert Scheibe | ISS-Spur quert das gerahmte Bildfeld |
| Trefferkriterium | Sep ≤ Scheibenradius | ISS-Bahn schneidet **FOV-Box** ums Objekt |
| Dauer | Scheibendurchmesser / ω | Zeit im Feld |
| Wert | eingefrorene Silhouette | Komposit Hintergrund + ISS |

Beide reduzieren sich auf dieselbe Kernrechnung, die `iss.js` schon macht:
**ISS-Az/El vs. Objekt-Az/El über die Zeit** (`transitPath` in `iss.js:251`).
A ist der Sonderfall „Objekt hat nennenswerte Scheibe"; B ist „Objekt ist
Punkt, das Feld ist die FOV-Box". Wir bauen **B als Verallgemeinerung** und
behalten A als Spezialfall mit echtem Scheibendurchmesser.

---

## 3. Entscheidungen (vom User, 2026-06-12)

- **Trefferkriterium:** Im Prinzip **beides** (FOV-Box *und* Winkel-Schwell-
  wert), aber **die FOV-Box des Zielobjekts ist das Relevante.** Das Teleskop
  wird auf das Zentrum des Objekts (feste RA/Dec, z. B. Capella oder M42)
  fokussiert; die FOV-Box liegt je nach Brennweite darauf. → FOV-Box ist
  primär, der reine Winkel-Schwellwert bleibt als Fallback/grober Filter.
- **Vorgehen:** **Erst dieses Design-Doc**, dann Implementierung.

---

## 4. Ziel-Modell (wie ein Objekt definiert wird)

Ein Zielobjekt ist eines von zwei Dingen:

1. **Ephemeriden-Body** (Sonne, Mond, Planeten): Position kommt live aus
   `astronomy-engine` über `Astronomy.Body.<Name>`. Hat einen echten,
   **zeitabhängigen** Winkeldurchmesser.
2. **Fixes Objekt** (Stern, DSO): feste **RA/Dec** (J2000/aktuell), via
   `Astronomy.DefineStar(Body.Star1…8, raHours, decDeg, distLy)` registriert,
   danach identisch über `Equator()`/`Horizon()` abgefragt. Winkeldurchmesser
   ist entweder 0 (Punkt) oder ein angegebener fester Wert (z. B. M42 ≈ 1°,
   M13 ≈ 0,3°) — nur für die optionale „durch das Objekt selbst"-Anzeige.

Beobachtungs-relevant ist in beiden Fällen die **FOV-Box** ums Objektzentrum:
Breite × Höhe in Grad, abgeleitet aus Sensor + Brennweite des jeweiligen Rigs
(oder direkt in Grad konfiguriert).

---

## 5. Geometrie-Änderungen (`src/geometry.js`)

- `bodyEnumOf()` (Zeile 174) erweitern: Planeten direkt auf
  `Astronomy.Body.{Mercury,Venus,Mars,Jupiter,Saturn,Uranus,Neptune}` mappen.
  `bodyAzEl()` selbst funktioniert unverändert (topozentrisch via
  `Equator(..., true, true)` → `Horizon`), für Planeten **und** Fixsterne.
- **Neuer Pfad für fixe RA/Dec:** ein Ziel kann statt eines Body-Strings ein
  `{ raHours, decDeg }` tragen. Entweder einmalig `DefineStar` registrieren
  oder eine schlanke direkte Äquatorial→Horizont-Rotation (GMST aus
  `sgp4.js` ist schon vorhanden). `DefineStar` bevorzugt — weniger eigener
  Astro-Code, nutzt dieselbe Refraktions-/Topozentrik-Pipeline.
- **Winkeldurchmesser-Helper:** `apparentDiameterDeg(target, whenUtc)` —
  für Planeten aus physikalischem Radius + `Equator().dist` (AU);
  `2·atan(r/d)`. Ersetzt das hartcodierte `bodyDiamDeg` in `iss.js:246`.
  Sonne/Mond behalten ihre bekannten ~0,53°.

## 6. Predictor-Änderungen (`src/iss.js`)

- `predictIssTransits` nimmt statt `bodies: ('Sun'|'Moon')[]` eine Liste von
  **Ziel-Deskriptoren** (Body **oder** RA/Dec **plus** FOV-Box + optional
  Scheibendurchmesser). Rückwärtskompatibel: ein String wird als Body gelesen.
- **FOV-Box-Trefferprüfung** statt nur `sep ≤ thresholdDeg`: prüfe, ob die
  ISS-Bahn die achsenausgerichtete Box (in Az/El relativ zum Objektzentrum,
  Az mit `cos(El)`-Korrektur) **schneidet**. Liefert:
  - **Eintritts-/Austritts-Zeitpunkt** im Feld + **Zeit im Feld**,
  - **Miss-Distance** (kleinster Abstand zum Zentrum, Bogenminuten) + **auf
    welcher Seite** (PA/Eintrittswinkel),
  - Klassifikation **„durch das Objekt"** (Miss < Objektradius) vs.
    **„daneben im Feld"**.
- **Scheiben-Dauer** (`buildIssCandidate`, Zeile 246–249) nutzt den echten
  `apparentDiameterDeg` statt der Sonne/Mond-Konstante. Für Punkt-Ziele
  entfällt die Okkultationsdauer; stattdessen zählt „Zeit im Feld".
- **Illuminations-Gate für Nacht-Ziele:** die ISS muss **sonnenbeschienen**
  sein (`issSunlit`, schon vorhanden) **und** der Himmel dunkel genug
  (Sonne unter ~−6°, Dark-Check aus `nextIssVisiblePass`), sonst ist die ISS
  nicht als Punkt/Spur erkennbar. Für Sonne/Mond-Transits bleibt das aus.
- `transitPath` (0,1-s-Schritte) bekommt zusätzlich **objektzentrierte
  Feld-Koordinaten** (dRA/dDec bzw. dAz·cosEl/dEl in Bogenminuten), damit UI
  und Compositing die Bahn direkt im Zielfeld zeichnen können.

## 7. Genauigkeit — der eigentlich limitierende Faktor

Der User betont die **exakte** Bahnbestimmung. Die Mathematik (SGP4) ist da;
der Fehler kommt fast vollständig aus der **TLE-Frische**:

- Ein TLE altert v. a. **along-track**: ~Hunderte Meter pro Tag Bahnfehler.
  Das verschiebt **Zeitpunkt** und **seitliche Lage** der Bahn um
  **Bogenminuten** — bei einer 0,5°-Sonnenscheibe egal, in einem engen
  DSO-Feld (z. B. 1500 mm → wenige Bogenminuten FOV) entscheidend.
- **Anforderung:** TLE für diese Ziele **< ~24 h** alt; Alter im
  Kandidaten anzeigen und bei Überschreitung warnen. `scripts/refresh-tle.js`
  existiert — hier nur strenger erzwingen + Frische in der Vorhersage führen.
- **Vertrauensmaß / Konfidenz-Stufen (für die Drehbuch-Spalte, §11):**
  geschätzter Along-track-Fehler aus dem TLE-Alter **am Ereigniszeitpunkt**
  (nicht am Jetzt) → „Bahn ±X′ / Timing ±Y s" und eine grobe Ampel
  🟢/🟡/🟠/🔴. Richtwert: TLE-Alter am Event < 1 d → 🟢, 1–3 d → 🟡,
  3–6 d → 🟠, > 6 d → 🔴 (Schwellen kalibrierbar via `transit_postmortem`-
  Historie, die es schon gibt).
- **ISS-Reboosts:** die ISS macht unvorhersehbare Bahnanhebungen (~monatlich),
  die eine SGP4-Prognose darüber hinaus **schlagartig** ungültig machen — daher
  ist die Konfidenz für die ISS am langen Ende grundsätzlich gedeckelt, nicht
  nur durch linearen Drift. HST/CSS sind ruhiger. Im Konfidenzmodell
  berücksichtigen (ISS-Langfrist nie besser als 🟠).

## 8. Config-Schema (`config.iss` / neuer `targets`-Block)

Skizze (final beim Implementieren):

```jsonc
"iss": {
  "skyTargets": {                 // neben Sun/Moon-Transits
    "enabled": false,
    "maxTleAgeHours": 24,         // Frische-Gate für Punkt/DSO-Ziele
    "requireSunlit": true,        // ISS muss beleuchtet sein
    "requireDarkSky": true,       // Sonne unter sunBelowDeg
    "sunBelowDeg": -6,
    "objects": [
      { "name": "Capella", "raHours": 5.278, "decDeg": 45.998,
        "fovWidthDeg": 0.8, "fovHeightDeg": 0.6 },
      { "name": "M42 (Orion)", "raHours": 5.588, "decDeg": -5.391,
        "diameterDeg": 1.0, "fovWidthDeg": 1.5, "fovHeightDeg": 1.0 },
      { "name": "Jupiter", "body": "Jupiter",
        "fovWidthDeg": 0.3, "fovHeightDeg": 0.3 },
      { "name": "M13", "raHours": 16.695, "decDeg": 36.460,
        "diameterDeg": 0.33, "fovWidthDeg": 0.6, "fovHeightDeg": 0.45 }
    ]
  }
}
```

FOV-Box entweder direkt in Grad **oder** aus Sensor (mm) + Brennweite (mm)
ableitbar (`fovDeg = 2·atan(sensor/(2·FL))`), passend zum Disc-xing-Tooltip,
der die mm/s @ FL schon kennt.

## 9. Workflow-/Trigger-Integration

- Der SharpCap/Capture-Trigger armt **nur den ISS-Lucky-Imaging-Burst** zum
  vorhergesagten T-0 (preBuffer/postBuffer wie heute). Die DSO-Langzeit-
  Acquisition ist getrennt und nicht Teil des Triggers.
- Pushover/E-Paper/Buzzer-Stufen (radio → candidate → imminent) greifen
  unverändert; Body-Label wird zum **Objektnamen** (Capella, M42, Jupiter).
- History/Disc-xing-Spalte: für Punkt-Ziele „Miss-Distance + Zeit im Feld"
  statt Scheibendurchgang.

## 10. Active-Target — welches Objekt liegt gerade am Teleskop an

Bis dato war das Beobachtungsobjekt **hartkodiert** (Sonne tags / Mond nachts,
pro Rig per `sharpcap.body` als `Sun|Moon`). Mit mehreren Nacht-Zielen muss
auswählbar sein, **worauf das Teleskop gerade gerichtet ist**.

**Zwei Achsen, nicht eine.** Es geht nicht nur um die ISS — **HST** und
**Tiangong/CSS** sind seit M81 (`config.iss.satellites`) bereits mitpropagiert
und müssen genauso berücksichtigt werden. Ein Ereignis ist also immer ein Paar:

- **Himmelsobjekt** (Sonne/Mond/Stern/Planet/DSO) — *wohin* das Teleskop
  physisch zeigt. **Das** ist das Active-Target eines Rigs.
- **Satellit** (ISS / HST / CSS) — *was* dort durch-/vorbeizieht. Pro Ereignis;
  am selben Objekt können nacheinander verschiedene Satelliten queren.

→ Man wählt das **Himmelsobjekt** (Pointing), und der Trigger armt für **jeden
Satelliten**, der dessen Feld heute Nacht quert. Die Timeline benennt pro
Eintrag den Satelliten (🛰 ISS / HST / CSS).

**Wo die Auswahl sitzt (Vorgabe des Users):**

- **Hauptrig:** Objekt-Auswahl als **Pull-down direkt oben im Haupt-View**
  (prominent, schneller Zugriff während der Nacht) — gefüllt **nicht** mit
  einem statischen All-Sky-Katalog, sondern mit den **Objekten, die heute
  Nacht real einen Treffer haben** (= die sortierten Predictor-Kandidaten).
  Man wählt nur aus, wofür es überhaupt etwas zu sehen gibt.
- **Weitere Rigs** (sofern definiert): deren Active-Target wird **in den
  Settings** gesetzt — dort, wo das Rig ohnehin definiert ist (SharpCap-Rig-
  Liste, künftiger Tab „Scopes"). Konsistent: Hauptrig oben/live, Zusatz-Rigs
  bei ihrer Definition.
- Das gewählte Objekt wird das **„scharfe"**: Capture-Trigger, Pushover/Buzzer-
  Countdown und FOV-Skizze des jeweiligen Rigs keyen darauf. Generalisiert
  `sharpcap.body` von `{Sun,Moon}` auf „beliebiges Active-Target".
- **Ein Scope = ein Objekt** zur Zeit (spiegelt die „Sun *oder* Moon"-Regel).
  Jedes Rig hat sein **eigenes** Active-Target → zwei dicht aufeinander folgende
  Events können auf zwei Teleskope verteilt werden.
- **Persistenz:** Laufzeit-/Betreiber-Zustand (welches Objekt angefahren ist),
  überlebt Reload; gehört nicht ins Config-Schema der Ziel-*Definitionen*,
  sondern ist Sitzungs-/Laufzeitzustand pro Rig.

## 11. Beobachtungsplan / „Drehbuch" — die Nacht-Timeline

Der eigentlich wertvolle Teil (Idee des Users): Die App **schlägt proaktiv**
auf Basis des **eigenen Standorts** vor, welche **Objekt-/Satelliten-
Kombination als Nächstes ansteht und wann genau** — über die **nächsten ~7 Tage**
(konfigurierbar), als nach Zeit sortierte Ranking-Tabelle. **Daran orientiert
sich der Astrofotograf — und stellt erst danach das Active-Target ein.** Es ist
also die **primäre, standardmäßig sichtbare Planungsfläche** im Web-View, nicht
ein versteckter Beifang:

```
Wann                 Objekt        Sat    Typ          El    Miss    Prognose
─────────────────────────────────────────────────────────────────────────────
heute 21:48          🌙 Mond       🛰ISS  Transit      41°   0,1°    🟢 sicher
heute 22:30          M42 (Orion)   🛰ISS  durch FOV    28°   6′      🟢 sicher
heute 22:54          M42 (Orion)   🛰CSS  durch FOV    25°   11′     🟢 sicher
heute 23:15          ♃ Jupiter     🛰ISS  Transit      35°   12″     🟢 sicher  ⚠ 8 min nach M42
Do 00:50             Vega          🛰HST  Appulse      60°   9′      🟡 mittel
Sa 21:10             ☀ Sonne       🛰ISS  Transit      30°   0,2°    🟠 grob
Di 03:20             M13           🛰CSS  durch FOV    44°   8′      🔴 unsicher
```

Damit weiß der Betreiber **wann er wohin schauen** muss, hakt das laufende
Ereignis ab und stellt das nächste Objekt als Active-Target ein.

- **Datenquelle:** Aggregation der bereits sortierten Predictor-Kandidaten
  über **alle aktivierten Satelliten** (ISS/HST/CSS, `config.iss.satellites`)
  **× alle aktivierten Ziele inkl. Sonne/Mond**, gemerged und nach Zeit
  sortiert. Read-Model, kein neuer Rechenkern — der Predictor läuft pro
  Satellit schon (`iss.horizonMs` ist bereits 14 d), hier werden die Ergebnisse
  nur zusammengeführt und über ~7 Tage angezeigt.
- **Pro Eintrag:** Objekt · **Satellit (ISS/HST/CSS)** · Uhrzeit (closest
  approach) · Typ (Scheiben-Transit / Bahn-durch-Feld / Appulse) · Elevation ·
  Sep/Miss · Satellit sonnenbeschienen? · TLE-Frische-/Konfidenz-Hinweis.
- **Konflikt-Erkennung:** Zwei Events innerhalb einer **Umschwenk-+Refokus-
  Zeit** (Minuten, konfigurierbar, z. B. `reslewMinGapMin`) sind mit **einem**
  Teleskop nicht beide machbar → als Konflikt markieren („⚠ nur 8 min nach
  M42"). Bei mehreren Rigs: Vorschlag, das Event dem freien Rig zuzuweisen.
- **„Up next":** Der nächste fällige Eintrag wird hervorgehoben; optional
  Vorschlag „Jetzt M42 als Active-Target setzen?". **Manuell bestätigen**, nicht
  automatisch umschalten — der Betreiber kennt die Realität (Wolken, Mount).
- **UI-Ort:** eigene Panel-Sektion in der Haupt-UI (neben/über der Live-Tracking-
  Liste), nicht in den Settings. Die Settings (Tab „Sky targets") definieren nur
  **welche Objekte im Katalog** sind; der Plan ist die Laufzeit-Ansicht daraus.
- **Prognose-Genauigkeit als eigene Spalte/Icon (wichtig):** Jede Zeile trägt
  einen Konfidenzwert, weil weit entfernte Vorhersagen unsicherer sind. Modell
  siehe §7 — Ableitung aus TLE-Alter am *Ereigniszeitpunkt* → grobe Stufen
  🟢 sicher / 🟡 mittel / 🟠 grob / 🔴 unsicher (Tooltip: geschätzter Bahn-/
  Timing-Fehler in ′ bzw. s). Sortierung primär nach Zeit; die Konfidenz ist
  die Entscheidungshilfe „lohnt sich das Aufbauen schon, oder erst näher dran
  nochmal prüfen".
- **Selbstschärfung:** Die Tabelle wird laufend neu gerechnet (`recomputeMs`),
  und `refresh-tle.js` zieht frische TLEs — ein heute „🟠 grob" 6 Tage entfernt
  liegendes Event wird mit näher rückendem Datum automatisch „🟢 sicher". Das
  im UI andeuten, damit der Nutzer weiß: ferne Einträge sind Platzhalter mit
  noch wachsender Genauigkeit, keine Festtermine.
- **Horizont:** Default ~7 Tage (`planHorizonDays`, ≤ `iss.horizonMs`/14 d).
  Pro Eintrag gilt das Nacht-/Tag-Gating: Sonnen-Transite tagsüber, alle
  anderen Ziele nur bei dunklem Himmel (Sonne unter `sunBelowDeg`) **und**
  sonnenbeschienenem Satelliten.

## 12. Pushover-Plan-Alerts — Benachrichtigung bei Konfidenz-Schwelle

Eigene, **opt-in** Pushover-Kategorie, **getrennt** von den bestehenden Live-
Transit-Alerts (radio/candidate/imminent). Ein Nutzer will evtl. nur die
Vorplanung, nicht das Live-Geblinke — oder umgekehrt; beide laufen parallel.

- **Auslöser (edge-triggered):** Ein Plan-Eintrag **erreicht erstmals** die
  konfigurierte Konfidenz-Schwelle (Default 🟢 grün) — ein künftiger Transit
  „verfestigt" sich. Feuert **genau einmal** pro Ereignis, **nicht** bei jedem
  Recompute.
- **Inhalt:** Objekt · Satellit (ISS/HST/CSS) · **genaue Uhrzeit** · Typ
  (Transit / durch-Feld / Appulse) · Elevation · Miss/Sep · Vorlaufzeit ·
  Konfidenz + Link (vorhandene `pushover.url`). Genau die „über welches Objekt
  und wann genau"-Info, die der User will.
- **Stabile Ereignis-Identität / Dedup (der knifflige Teil):** Die closest-
  approach-Zeit eines fernen Events wandert bei jedem TLE-Refresh um Sekunden.
  → Fuzzy-Key `(satTag, objectId, time-bucket ~±2 min)` in der DB, damit
  **dasselbe physische Ereignis** über Recomputes hinweg wiedererkannt wird.
  Pro Key wird gespeichert, welche Schwelle schon gemeldet wurde → ein Upgrade
  🟠→🟢 meldet einmal, kein Spam, **übersteht Neustart**.
- **Konfig** (`iss.skyTargets.planAlerts`): `enabled`, `minConfidence`
  (`green|amber`), `minElevationDeg`, Satelliten-/Objekt-Filter, `leadMaxDays`
  (nur Events innerhalb X Tagen melden), optional Ruhezeiten (keine Pushes
  nachts 01–07 Uhr o. ä.).
- **Abgrenzung:** Planungs-/Vorschau-Push über bis zu `leadMaxDays` Tage,
  **unabhängig** von der bestehenden `iss.notifyWithinMs`-T-minus-Logik (3 d).
- **Wiederverwendung:** baut auf `pushover.js` / `notifier.js`; nur eine neue
  Nachrichten-Kategorie + ein kleines DB-Tabellchen für den Dedup-State (analog
  zu sightings/postmortem in `store.js`). Validierung transaktional (lessons.md
  2026-06-08).
- **Optional (offene Frage):** auch melden, wenn ein zuvor grün gemeldetes
  Event **wieder unsicher wird oder wegfällt** (z. B. ISS-Reboost verschiebt es)
  — „Plan geändert"-Push, damit man nicht umsonst aufbaut.

## 13. Nicht-Ziele / spätere Features

- **Zentrallinien-/Bodenspur-Export** (für Planeten-Scheiben-Transits, deren
  Zentrallinie nur zig Meter breit ist → „hinfahren"-Workflow): eigenes,
  größeres Feature. **Nicht** in diesem Schritt.
- **Steuerung der DSO-Acquisition** (Mount/Stacking): außerhalb des Projekts.
- **Auto-Compositing** der zwei Aufnahmen: Post-Processing des Users.

---

## 14. Plan (nach Freigabe dieses Docs)

- [ ] `geometry.js`: `bodyEnumOf` Planeten; RA/Dec-Pfad (`DefineStar`);
      `apparentDiameterDeg()`.
- [ ] `iss.js`: Ziel-Deskriptoren; FOV-Box-Treffer (Eintritt/Austritt, Miss,
      Seite); echte Scheibendauer; Illuminations-/Dark-Gate; feldzentrierte
      `transitPath`-Koordinaten.
- [ ] `service.js`: `iss.skyTargets`-Config validieren (transaktional, vgl.
      lessons.md 2026-06-08); TLE-Frische-Gate; in den Recompute-Zyklus hängen.
- [ ] TLE-Frische am Kandidaten führen + anzeigen; Warnung bei Überalterung.
- [ ] Predictor über **alle aktivierten Satelliten × alle Ziele** laufen lassen
      (ISS/HST/CSS aus `config.iss.satellites` × `iss.skyTargets.objects`).
- [ ] **Active-Target-Zustand** (pro Rig): generalisiert `sharpcap.body`;
      Trigger/Alerts/FOV keyen darauf; Laufzeit-persistent.
- [ ] **Hauptrig:** Objekt-Pull-down **oben im Haupt-View**, gefüllt aus den
      Tonight-Kandidaten.
- [ ] **Zusatz-Rigs:** Active-Target-Auswahl **in den Settings** (bei der
      Rig-Definition / Tab „Scopes").
- [ ] **Beobachtungsplan-Tabelle (primär, default sichtbar):** gemergte,
      zeitsortierte ~7-Tage-Ranking-Tabelle über alle Satelliten × Ziele inkl.
      Sonne/Mond; Satellit pro Eintrag; **Prognose-Konfidenz-Spalte/Icon**
      (🟢/🟡/🟠/🔴 aus §7); Konflikt-Markierung (`reslewMinGapMin`); „Up next"
      + manueller „als Active-Target setzen"-Vorschlag; `planHorizonDays`.
- [ ] Trigger nur ISS-Burst; Body-Label = Objektname; Disc-xing-Spalte für
      Punkt-Ziele.
- [ ] Tests: Planet-Az/El, RA/Dec-Stern-Az/El, FOV-Box-Treffer (durch vs.
      daneben), Illuminations-Gate, apparentDiameter, Timeline-Merge+Sort,
      Konflikt-Erkennung.
- [ ] **Pushover-Plan-Alerts:** edge-getriggerte Push bei Erreichen der
      Konfidenz-Schwelle; Fuzzy-Dedup-State in DB (neustart-fest); Konfig
      `iss.skyTargets.planAlerts`; Settings-Feld im Tab „Pushover".
- [ ] README/MILESTONES: M83; Workflow-Trennung (DSO-Stack + ISS-Lucky-Frame);
      Drehbuch/Active-Target; Plan-Alerts.

## 15. Offene Fragen

- FOV-Box **achsenausgerichtet** (Az/El) ausreichend, oder muss die
  **Kamerarotation** (PA des Sensors) berücksichtigt werden?
- RA/Dec-Eingabe **J2000** (Katalogwert, dann Präzession) oder
  **scheinbar/aktuell**? (`DefineStar` erwartet J2000 — Präzession übernimmt
  die Engine.)
- Objektliste **kuratiert mitgeliefert** (helle Sterne/Messier) oder rein
  benutzerdefiniert? (vgl. lessons.md: keine Knöpfe ohne echten Mehrwert.)
- Active-Target **rein manuell** umschalten, oder „Up next" mit **Bestätigung**
  (kein stilles Auto-Advance — Betreiber kennt Wolken/Mount)?
- Konflikt-Schwelle `reslewMinGapMin` **fester Default** (z. B. 5 min) oder pro
  Standort/Rig konfigurierbar (langsame vs. schnelle Montierung)?
- Drehbuch-Panel als **eigene Haupt-UI-Sektion** oder als Tab/Akkordeon neben
  der Live-Tracking-Liste — Platzbudget der Hauptseite?
