# Design — ISS-Bahn durch/neben beliebige Zielobjekte (Sterne · Planeten · DSO)

Branch: `claude/astrophotography-telescope-objects-t2nygw`
Status: **DESIGN / zur Abstimmung** — noch kein Code.
Milestone-Vorschlag: M82.

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
- Optional als Vertrauensmaß: geschätzter Along-track-Fehler aus TLE-Alter →
  „Bahn ±X′ / Timing ±Y s" am Kandidaten ausweisen.

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

## 10. Nicht-Ziele / spätere Features

- **Zentrallinien-/Bodenspur-Export** (für Planeten-Scheiben-Transits, deren
  Zentrallinie nur zig Meter breit ist → „hinfahren"-Workflow): eigenes,
  größeres Feature. **Nicht** in diesem Schritt.
- **Steuerung der DSO-Acquisition** (Mount/Stacking): außerhalb des Projekts.
- **Auto-Compositing** der zwei Aufnahmen: Post-Processing des Users.

---

## 11. Plan (nach Freigabe dieses Docs)

- [ ] `geometry.js`: `bodyEnumOf` Planeten; RA/Dec-Pfad (`DefineStar`);
      `apparentDiameterDeg()`.
- [ ] `iss.js`: Ziel-Deskriptoren; FOV-Box-Treffer (Eintritt/Austritt, Miss,
      Seite); echte Scheibendauer; Illuminations-/Dark-Gate; feldzentrierte
      `transitPath`-Koordinaten.
- [ ] `service.js`: `iss.skyTargets`-Config validieren (transaktional, vgl.
      lessons.md 2026-06-08); TLE-Frische-Gate; in den Recompute-Zyklus hängen.
- [ ] TLE-Frische am Kandidaten führen + anzeigen; Warnung bei Überalterung.
- [ ] Trigger nur ISS-Burst; Body-Label = Objektname; Disc-xing-Spalte für
      Punkt-Ziele.
- [ ] Tests: Planet-Az/El, RA/Dec-Stern-Az/El, FOV-Box-Treffer (durch vs.
      daneben), Illuminations-Gate, apparentDiameter.
- [ ] README/MILESTONES: M82; Workflow-Trennung (DSO-Stack + ISS-Lucky-Frame).

## 12. Offene Fragen

- FOV-Box **achsenausgerichtet** (Az/El) ausreichend, oder muss die
  **Kamerarotation** (PA des Sensors) berücksichtigt werden?
- RA/Dec-Eingabe **J2000** (Katalogwert, dann Präzession) oder
  **scheinbar/aktuell**? (`DefineStar` erwartet J2000 — Präzession übernimmt
  die Engine.)
- Objektliste **kuratiert mitgeliefert** (helle Sterne/Messier) oder rein
  benutzerdefiniert? (vgl. lessons.md: keine Knöpfe ohne echten Mehrwert.)
