# sun-moon-transit-predictor

Sagt Flugzeug-Transits vor Sonnen- und Mondscheibe vorher und sendet
Pushover-Notifications, damit die Hochgeschwindigkeitskamera am Teleskop
rechtzeitig scharfgestellt werden kann. Läuft auf einem Raspberry Pi 5
neben `dump1090-fa` als systemd-Service mit Web-UI und SQLite-Historie.

```
[ADS-B-Antenne] → [dump1090-fa]      port 8080
                       │
                       ▼ poll 2 s
                  [stp.service]      port 8081 (Web UI + JSON-API)
                       │                     ↘
                       ▼                      → SQLite history
                  [Pushover]                  → Pushover (early + precise)
```

## Wichtige URLs

| Was | URL |
|---|---|
| Repo | https://github.com/joergs-git/sun-moon-transit-predictor |
| Pull Request M2–M7 | https://github.com/joergs-git/sun-moon-transit-predictor/pull/1 |
| Web-UI auf dem Pi | `http://<pi-ip>:8081/` (z. B. `http://sunmoontransiter.local:8081/`) |
| dump1090-fa SkyAware-Karte | `http://<pi-ip>:8080/` |
| Roh-`aircraft.json` | `http://<pi-ip>:8080/data/aircraft.json` |
| STP `/api/state` (live JSON) | `http://<pi-ip>:8081/api/state` |
| STP `/api/history` | `http://<pi-ip>:8081/api/history?limit=100` |
| STP `/api/health` | `http://<pi-ip>:8081/api/health` |
| Pushover-App-Token anlegen | https://pushover.net/apps/build |
| Pushover-User-Key | https://pushover.net/ (oben rechts "Your User Key") |
| FlightAware PiAware Install | https://www.flightaware.com/adsb/piaware/install |
| adsbdb.com (Callsign→Route, free) | https://api.adsbdb.com/v0/callsign/{callsign} |
| Astronomy Engine (Sonne/Mond) | https://github.com/cosinekitty/astronomy |
| Raspberry Pi Imager | https://www.raspberrypi.com/software/ |

---

## TL;DR — Operator-Befehle

```bash
# Start / Stop / Restart
sudo systemctl start  stp.service
sudo systemctl stop   stp.service
sudo systemctl restart stp.service

# Live-Logs
journalctl -u stp.service -f

# Status (Service + letzte 5 Logzeilen)
systemctl status stp.service

# Bei Boot starten / nicht starten
sudo systemctl enable  stp.service
sudo systemctl disable stp.service

# Genauso für dump1090-fa
sudo systemctl restart dump1090-fa
journalctl -u dump1090-fa -n 30 --no-pager
```

## Dateien — wo liegt was

Standard-Installations-Pfad: `/home/sunmoon/sun-moon-transit-predictor/`
(angepasst, wenn du den Repo woanders hin geklont hast).

| Pfad | Inhalt |
|---|---|
| `config/observer.json` | Standort (Lat/Lon/Höhe, Temp/Druck für Refraktion). Fest committed mit Rheine-Defaults. **Nach erstem Install anpassen.** |
| `config/service.json` | Laufzeit-Config (URLs, Pushover-Keys, Port, DB-Pfad). Wird beim Install interaktiv erzeugt. **Nicht in Git** (`.gitignore`). |
| `config/service.example.json` | Vorlage zum Hand-Editieren, falls man das Install-Script umgehen will. |
| `data/history.db` | SQLite-Historie aller `early`/`precise`-Notifications. Vom systemd-Sandboxing als einzige beschreibbare Stelle freigegeben (`ReadWritePaths`). |
| `bin/stp.js` | Service-Entry-Point (`node --experimental-sqlite bin/stp.js`). |
| `web/` | Statisches Frontend (HTML+CSS+ES-Module-JS, kein Build-Step). |
| `src/` | Service-Code (geometry, tracker, notifier, store, server, …). |
| `test/` | Vitest-Suite, 53 Cases. |
| `scripts/install-pi5.sh` | Idempotenter Installer (Node, npm install, Configs, systemd). |
| `systemd/stp.service` | Unit-Template. Bei Install nach `/etc/systemd/system/stp.service` mit User/Pfad-Substitution. |
| `/etc/systemd/system/stp.service` | Aktive Unit-Datei nach Install. |

## Gewohnte Operationen

### Beobachterstandort ändern

```bash
sudo systemctl stop stp.service
nano config/observer.json
sudo systemctl start stp.service
```

### Pushover- oder ADS-B-URL ändern

Variante A: Service-Config neu prompten (interaktiv):
```bash
bash scripts/install-pi5.sh --overwrite
```

Variante B: direkt editieren:
```bash
sudo systemctl stop stp.service
nano config/service.json
sudo systemctl start stp.service
```

### Update aus Git pullen

```bash
cd /home/sunmoon/sun-moon-transit-predictor
git pull
npm install --omit=dev
sudo systemctl restart stp.service
```

### Historie inspizieren (ohne UI)

```bash
sqlite3 data/history.db 'SELECT datetime(recorded_at_ms/1000,"unixepoch","localtime"), stage, body, flight, origin, destination, closest_sep_deg FROM transit_history ORDER BY recorded_at_ms DESC LIMIT 20;'
```

### Tests laufen lassen (auf Dev-Maschine, nicht Pi)

```bash
npm install
npm test           # 53 Cases, Vitest
```

## Konfigurations-Felder

### `config/observer.json`

```json
{
  "name": "Rheine",
  "latitudeDeg": 52.2833,
  "longitudeDeg": 7.4406,
  "elevationM": 50.0,
  "temperatureC": 10.0,
  "pressureMbar": 1010.0
}
```

`elevationM` wird als WGS84-h interpretiert (Geoid-Undulation Rheine ~46 m
ist als bekannte Limitation akzeptiert; im Az/El-Fehler liegt das im
einstelligen Bogensekunden-Bereich).

### `config/service.json`

```json
{
  "adsb":     { "url": "http://localhost:8080/data/aircraft.json", "pollIntervalMs": 2000 },
  "tracker":  { "horizonS": 60, "stepS": 1, "thresholdDeg": 0.3, "bodies": ["Sun", "Moon"] },
  "pushover": { "token": "...", "user": "...", "device": "", "enabled": true },
  "server":   { "port": 8081, "host": "0.0.0.0", "publicUrl": "http://<pi-ip>:8081/" },
  "store":    { "path": "/home/sunmoon/sun-moon-transit-predictor/data/history.db" },
  "routes":   { "enabled": true, "ttlMs": 3600000, "negativeTtlMs": 300000 }
}
```

| Schlüssel | Default | Wirkung |
|---|---|---|
| `tracker.horizonS` | 60 | Wie weit in die Zukunft extrapoliert wird (s). |
| `tracker.stepS` | 1 | Auflösung der Vorhersage-Stützpunkte (s). |
| `tracker.thresholdDeg` | 0.3 | Max. Winkelabstand für einen Kandidaten. Sonnenradius ≈ 0.27°, also 0.3° = grenznah. Strenger setzen für nur zentrierte Transits. |
| `tracker.bodies` | `["Sun","Moon"]` | Auf `["Sun"]` reduzieren, wenn Mond uninteressant. |
| `pushover.enabled` | `true` wenn token+user vorhanden, sonst `false` | Push deaktivierbar ohne Codeänderung. |
| `routes.enabled` | `true` | adsbdb.com-Lookups für Origin/Destination. Bei `false` kommt die Notification ohne Routendaten. |

## Zwei-Stufen-Notifications

Pro `(icao, body)`-Paar:

1. **early** — beim ersten Auftauchen des Kandidaten. Pushover-Priority 0.
2. **precise** — sobald `closestApproachAtMs` in ±30 s vom jetzigen Zeitpunkt liegt. Priority 1.

State pro Paar wird nach 5 min ohne Wiedersichten gedroppt. Beide Stufen
landen mit vollem Payload (Callsign, IATA-Flugnummer, Airline, Origin/Dest,
Höhe, Speed, min. Sep, Dauer, ETA) zusätzlich in der SQLite-Historie.

## Beobachtbarkeitsschwelle

Sonne und Mond zählen erst ab **>20° Elevation** als „relevant". Unterhalb
liefert `isObservable()` `false` und der Tracker überspringt diesen Body
beim aktuellen Tick. In der Web-UI erkennst du das am `—` in der
"OBSERVABLE"-Spalte.

## Troubleshooting

### UI zeigt 0 aircraft trotz Empfang

- `curl http://localhost:8080/data/aircraft.json` liefert Einträge ohne `lat`/`lon`?
  → Erwartetes Verhalten. STP filtert Targets ohne Position-Fix raus, da
  Az/El-Geometrie ohne Koordinaten nicht möglich ist. Sobald dump1090
  Position-Frames dekodiert (typisch <60 s nach erstem Sichten), erscheint
  der Eintrag.

### dump1090 läuft, aber 0.0 msgs/sec

Wahrscheinlichste Ursachen, in absteigender Häufigkeit:

1. **Falscher Tuner.** Im Log nach `Found … tuner` schauen.
   - `R820T` / `R820T2` → richtig für 1090 MHz.
   - `FC0013` / `FC0012` / `E4000` → kann 1090 MHz nicht oder nur sehr schlecht. Anderen Stick einsetzen (Original RadarBox FlightStick, FlightAware Pro Stick Plus, Nooelec NESDR Smart).
2. **Antenne lose** oder schlechte Position. SkyAware-Karte unter `:8080/` zeigt RSSI; bei -45 dB und schlechter ist der RF-Pfad gestört.
3. **DVB-Treiber klaut den Stick.** `lsmod | grep rtl` zeigt geladene Module; dump1090 detacht zur Laufzeit, aber Race-Conditions gibt's. Blacklist:
   ```bash
   sudo tee /etc/modprobe.d/blacklist-rtl-sdr.conf >/dev/null <<'EOF'
   blacklist dvb_usb_rtl28xxu
   blacklist rtl2832
   blacklist rtl2830
   blacklist rtl2832_sdr
   EOF
   sudo update-initramfs -u
   sudo reboot
   ```

### `Error: Unable to locate package dump1090-fa`

FlightAware-Repo nicht eingerichtet. Mit Bookworm:
```bash
cd /tmp
wget https://www.flightaware.com/adsb/piaware/files/packages/pool/piaware/p/piaware-support/piaware-repository_10.2_all.deb
sudo dpkg -i piaware-repository_10.2_all.deb
sudo apt update
sudo apt install -y dump1090-fa
sudo reboot
```

### Pushover kommt nicht an

```bash
journalctl -u stp.service -n 50 | grep -i push
```
Prüfe in der Service-Log-Ausgabe nach „Pushover error". `pushover.enabled:true` + gültige Tokens vorausgesetzt; bei `disabled` läuft alles, Notifications werden nur lokal in der Historie aufgezeichnet.

### Service startet nicht

```bash
journalctl -u stp.service -n 50 --no-pager
```
Häufige Ursachen:
- `node:sqlite` nicht verfügbar → Node-Version unter 22. Mit `node -v` prüfen.
- Port 8081 belegt → in `service.json` ändern.
- `data/`-Verzeichnis nicht beschreibbar → systemd `ReadWritePaths` zeigt nur `…/data`. Repo-Owner muss `sunmoon` sein (oder der User aus der Unit-Datei).

## Pi 5 Erstinstall — kompletter Pfad

1. Pi Imager → "Raspberry Pi OS Lite (64-bit)" (Bookworm — **nicht Trixie**, FlightAware-Repo unterstützt Trixie noch nicht).
2. Imager → "Edit Settings": Hostname (z. B. `sunmoontransiter`), SSH + Key, Wi-Fi/Country, User, Locale.
3. SD-Karte boot, SSH rein.
4. dump1090-fa installieren:
   ```bash
   cd /tmp
   wget https://www.flightaware.com/adsb/piaware/files/packages/pool/piaware/p/piaware-support/piaware-repository_10.2_all.deb
   sudo dpkg -i piaware-repository_10.2_all.deb
   sudo apt update
   sudo apt install -y dump1090-fa git
   sudo reboot
   ```
5. STP installieren:
   ```bash
   cd ~
   git clone https://github.com/joergs-git/sun-moon-transit-predictor.git
   cd sun-moon-transit-predictor
   bash scripts/install-pi5.sh
   ```
6. Beobachterstandort prüfen/anpassen (`config/observer.json`).
7. Browser → `http://<pi-ip>:8081/`. Fertig.

Re-Run `bash scripts/install-pi5.sh --overwrite` neu prompt jederzeit
möglich; Standard-Re-Run ohne Flag lässt vorhandene Configs unangetastet.

## HTTP-API

| Pfad | Beschreibung |
|---|---|
| `GET /api/state`                  | Aktueller Snapshot: Observer, Sky-now (Sonne/Mond Az/El + Observable), Aircraft-Count, Kandidaten innerhalb des Horizonts. Refresh per UI alle 2 s. |
| `GET /api/history?limit=N`        | Historie (Default 100, max 500), neueste zuerst. |
| `GET /api/health`                 | Liveness-Probe. |
| `GET /` etc.                      | Statisches Web-UI aus `web/`. |

## Annahmen und bekannte Limits

- Geometrie: 0° = N, 90° = E. WGS84 → ECEF → ENU für Flugzeug-Az/El.
- Refraktion: Standard-Astronomy-Engine `'normal'`-Modell. Über 20° irrelevant (<0.05°).
- Aircraft-Höhe: bevorzugt `alt_geom`, Fallback `alt_baro`. Beides als MSL → direkt als WGS84-h verwendet.
- Extrapolation: linear, lokale Tangentenebene, 60 s Horizont. Fehler vs. Geodäte unter 1 m bei realistischen Speeds.
- ADS-B-Latenz: `seen_pos` wird auf `receivedAtMs` zurückdatiert, der Tracker projiziert ab tatsächlichem Sample-Zeitpunkt.
- Geoid-Undulation Rheine ~46 m wird ignoriert.
- Kein Kamera-Trigger — STP pusht, du armierst die Kamera selbst.

## Status

| Milestone | Inhalt | Status |
|---|---|---|
| M1 | Pi-Empfänger-Setup (`dump1090-fa`) | Hardware, außerhalb Repo |
| M2 | Geometrie-Kern (Az/El, Sonne/Mond, Separation) | done |
| M3 | Live-Tracker (`aircraft.json`-Polling, Extrapolation, Kandidaten) | done |
| M4 | Pushover-Notifier (zwei-stufig, mit Flugdaten) | done |
| M5 | adsbdb.com Route-Lookup (Origin/Destination/IATA-Flugnummer) | done |
| M6 | Web-UI auf dem Pi (Live-Liste + persistente Historie) | done |
| M7 | Bash-Installer für Pi 5 (Raspberry Pi OS, ARM64) | done |

## Layout

```
.
├── package.json              src deps + npm-Scripts
├── vitest.config.js          Test-Runner-Config
├── bin/stp.js                Service-Entry-Point
├── config/
│   ├── observer.json         Standort
│   └── service.example.json  Vorlage für service.json
├── src/
│   ├── geometry.js           topozentrische Az/El + Großkreis-Separation
│   ├── adsb.js               fetch + normalise dump1090 aircraft.json
│   ├── tracker.js            Extrapolation + Transit-Detektion
│   ├── pushover.js           Pushover-REST-Client
│   ├── notifier.js           zwei-stufige Dispatch + Dedup
│   ├── adsbdb.js             Callsign→Route, In-Memory TTL-Cache
│   ├── store.js              SQLite-Historie (node:sqlite)
│   ├── server.js             HTTP-Server (Built-in, kein Framework)
│   ├── service.js            Orchestrator (Polling-Loop)
│   ├── config.js             loadObserver()
│   └── index.js              Public Re-Exports
├── web/
│   ├── index.html            Live + History UI
│   ├── app.js                Vanilla-JS-Poller
│   └── style.css             Dark-Theme
├── scripts/install-pi5.sh    idempotenter Installer
├── systemd/stp.service       Unit-Template
└── test/                     8 Vitest-Files, 53 Cases
```
