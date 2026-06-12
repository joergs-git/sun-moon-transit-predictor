# Design — Massen-Pushover-Dienst: ISS/HST/CSS-Transits für viele Standorte

Branch: `claude/astrophotography-telescope-objects-t2nygw`
Status: **IDEE / DESIGN** — separates Satelliten-Projekt zum Haupt-Repo.
Abhängigkeit: profitiert stark vom Zentrallinien-/Korridor-Feature
(bisher „Nicht-Ziel" in `dso-iss-path-prediction.md` §13 — würde hierfür
zum Kernstück).

---

## 1. Idee

Hunderte (bis tausende) Nutzer hinterlegen **Pushover-Key + Standort**
(lat/lon/elev) in einer Supabase-Datenbank. Ein **GitHub-Actions-Worker**
rechnet periodisch, ob an einem dieser Standorte die **ISS / HST / Tiangong**
vor **Sonne oder Mond** vorbeizieht, und schickt den Betroffenen **24–48 h
vorher** eine Pushover-Nachricht mit Objekt, Satellit und **exakter Uhrzeit**.

Es ist „ISS Transit Finder, aber push-basiert": niemand muss nachschlagen —
der Dienst meldet sich, wenn es am eigenen Standort etwas zu sehen gibt.

### Scope-Entscheidungen (User, 2026-06-12)

- **Nur Vorankündigung**, 24–48 h vor dem Ereignis. Kein Live-Countdown —
  die Nachricht enthält die exakte Uhrzeit, den Wecker stellt der Empfänger.
- **Werbelink zum GitHub-Projekt** in jeder Nachricht (Pushover `url` +
  `url_title`, z. B. „🔭 sun-moon-transit-predictor auf GitHub").
- **Kein DSGVO-/Compliance-Apparat**: internationales Hobby-Angebot, Teilnahme
  ist freiwillig — wer nicht will, trägt sich nicht ein. Der **Abmelde-Link**
  bleibt trotzdem in jeder Nachricht (eigene Anforderung; zugleich Spam-Hygiene
  und schont das Pushover-Kontingent).
- **Sonne + Mond** als Start-Scope. Planeten-/Stern-Appulses später —
  Quota-relevant (s. §6) und ohne Teleskop-Kontext weniger wert.

## 2. Architektur

```
[Anmelde-Webseite (statisch + Edge Function)]
        │  validiert Pushover-Key via users/validate.json
        ▼
Supabase
  users(id, pushover_key, lat, lon, elev_m,
        bodies, sats, min_elev_deg, created_at)
  notified(user_id, event_key, sent_at)          ← Dedup, neustart-fest
        ▲                                  ▲
        │ service-role key (GH-Secret)     │
        ▼                                  │
[GitHub Actions, cron alle 6–12 h]         │
  node scripts/mass-notify.js              │
    1. TLEs ziehen (refresh-tle.js, vorhanden)
    2. Pro Satellit × Pass: Transit-KORRIDOR am Boden rechnen (einmal!)
    3. User per Distanz-zur-Zentrallinie matchen (O(Pässe)+O(User))
    4. Fenster-Filter: Ereignis in 24–48 h? Noch nicht gemeldet?
    5. Pushover senden (pushover.js, vorhanden) + notified-Zeile schreiben
        │
        ▼  Nachricht:
  „🛰 ISS quert die Sonne bei dir: Do 14:02:31 (El 38°, 0,8 km zur
   Zentrallinie). — [Projekt auf GitHub] · [Abmelden]"
                                              │
            Supabase Edge Function ◀──────────┘
            GET /unsubscribe?token=HMAC(user_id) → Zeile löschen, fertig
```

## 3. Rechenweg: Korridor statt Brute-Force

Naiv (für jeden User `predictIssTransits` über 48 h) funktioniert bei
Hunderten Usern (~Minuten pro Lauf), skaliert aber falsch. Richtig herum
gedacht nutzt es die Physik:

- Ein Satelliten-Transit vor Sonne/Mond hat am Boden einen **schmalen
  Sichtbarkeits-Korridor** (Zentrallinie wenige km breit + Toleranzband).
- Der Worker rechnet **pro Pass einmal** den Bodenpfad (Schnitt der
  Sichtlinie Satellit→Sonne/Mond mit dem WGS84-Ellipsoid, Zeitschritt-weise;
  SGP4 + `bodyAzEl` aus dem Repo) und matcht dann **alle** User mit einer
  simplen Distanz-zur-Linie-Abfrage.
- Aufwand: O(Pässe × Zeitschritte) + O(User) — unabhängig von der Userzahl
  im teuren Teil. Brute-Force mit geteiltem Ephemeriden-Cache ist als
  v1-Abkürzung okay; der Korridor ist die Zielarchitektur und nützt als
  Feature auch dem Einzelnutzer-Pi („wohin fahren für den Jupiter-Transit").
- Pro Treffer kennt der Korridor auch die **Querdistanz** des Users zur
  Zentrallinie → in die Nachricht („0,8 km zur Zentrallinie") und als
  Qualitätsmaß (am Rand des Korridors = streifend).

## 4. GitHub Actions als Worker — Eignung & Grenzen

- **Geeignet**, weil: Scheduled Workflow, gratis auf öffentlichem Repo, und
  der Worker kann den Rechenkern (`src/sgp4.js`, `src/geometry.js`,
  `src/iss.js` — dependency-frei) **direkt aus diesem Repo** importieren.
- **Grenzen:** Cron feuert unzuverlässig (Minuten Verzug bis ausgelassene
  Läufe) → für 24–48-h-Vorankündigung egal, für Echtzeit unbrauchbar
  (bewusst nicht im Scope). Lauf-Frequenz 6–12 h reicht: jedes Ereignis wird
  von mehreren Läufen gesehen, bevor sein 24–48-h-Fenster beginnt.
- **Secrets:** `SUPABASE_SERVICE_KEY`, `PUSHOVER_APP_TOKEN` als
  Actions-Secrets. Öffentliche Workflow-Logs → niemals Keys/Userdaten loggen.
- TLE-Frische ist hier unkritischer als beim Pi-Live-Betrieb: Lauf zieht
  immer frische TLEs, und 24–48 h Propagation ist SGP4-Kernkompetenz
  (Timing-Fehler ≪ 1 s bei frischem TLE; Konfidenz-Logik aus
  `dso-iss-path-prediction.md` §7 wiederverwendbar).

## 5. Dedup & Ereignis-Identität

Gleiches Muster wie bei den Plan-Alerts (§12 im Haupt-Doc), nur in Supabase:
`event_key = satTag|body|userId|Zeitbucket(±2 min)`. Jeder Lauf prüft vor dem
Senden gegen `notified` → genau **eine** Nachricht pro User und Ereignis,
egal wie oft der Cron läuft oder wie die closest-approach-Zeit zwischen
TLE-Refreshes wandert.

## 6. Pushover-Mechanik & Kontingent

- **Ein** App-Token (des Betreibers); jeder User trägt nur seinen **User Key**
  ein. Beim Anmelden via `users/validate.json` prüfen → Tippfehler fallen
  sofort auf, keine toten Keys in der DB.
- Kontingent: **10 000 Nachrichten/Monat** pro Application (free tier).
  Sonnen-/Mond-Transits an einem festen Standort sind selten (Größenordnung:
  Sonne ~alle paar Wochen) → selbst 1000 User ≈ Hunderte Nachrichten/Monat.
  Erst lockere Appulse-Schwellen würden das Limit gefährden → Start-Scope
  bleibt Sonne/Mond, Schwellen konservativ.
- Sende-Fehler 4xx mit `user is invalid` → User-Zeile deaktivieren
  (selbstreinigend).

## 7. An-/Abmeldung

- **Anmeldung:** statische Seite (GitHub Pages reicht) + Supabase Edge
  Function: Pushover-Key, Standort (Karten-Picker oder lat/lon-Felder),
  optional min. Elevation. Key-Validierung sofort. Optionales Double-Opt-in
  (erste Push „Bestätige mit Klick") verhindert Eintragen fremder Keys —
  empfohlen, da fremde Keys sonst Spam an Unbeteiligte bedeuten.
- **Abmeldung:** Link in **jeder** Nachricht:
  `GET /unsubscribe?token=HMAC(user_id, secret)` → Edge Function löscht die
  Zeile. Kein Login, ein Klick, fertig.

## 8. Abgrenzung zum Haupt-Repo

- Eigenes kleines Projekt (Worker-Script + Workflow + Supabase-Schema +
  Anmeldeseite), das den Rechenkern aus diesem Repo **importiert** — kein
  Eingriff in den Pi-Dienst.
- Sinnvolle Reihenfolge: **erst** das Korridor-/Zentrallinien-Feature (nützt
  auch dem Einzelnutzer), **dann** ist der Massen-Worker fast nur Glue-Code.

## 9. Plan (wenn es konkret wird)

- [ ] Korridor-Rechnung: Satellit→Sonne/Mond-Sichtlinie ↔ Ellipsoid-Schnitt,
      Bodenpfad + Breite pro Pass (eigenes Modul, testbar; auch fürs Pi-UI).
- [ ] Supabase-Schema (`users`, `notified`) + Edge Functions
      (subscribe/validate, unsubscribe mit HMAC-Token).
- [ ] `scripts/mass-notify.js`: TLE-Refresh → Korridore → User-Match →
      24–48-h-Fenster → Dedup → Pushover (mit GitHub-Werbelink + Abmeldelink).
- [ ] GitHub-Actions-Workflow (cron 6–12 h, Secrets, kein Datenleak in Logs).
- [ ] Anmeldeseite (statisch, Karten-Picker, Key-Validierung, Double-Opt-in).
- [ ] Tests: Korridor-Geometrie gegen bekannte Transit-Vorhersagen;
      Dedup-Verhalten über mehrere Läufe; Fenster-Logik (24–48 h).

## 10. Offene Fragen

- Eigenes Repo oder Unterordner hier? (Actions-Minuten sind nur auf
  öffentlichen Repos gratis; Worker braucht den Rechenkern als Import —
  einfachster Start: gleiches Repo, eigener Workflow.)
- Double-Opt-in ja/nein (empfohlen wegen Fremd-Key-Missbrauch).
- Nachricht ein- oder zweistufig (nur 24–48 h vorher, oder zusätzlich eine
  Erinnerung ~1 h vorher — kostet Kontingent, Cron-Jitter beachten).
- Karten-Picker vs. nur lat/lon-Felder auf der Anmeldeseite.
