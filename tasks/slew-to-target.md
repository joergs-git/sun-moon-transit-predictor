# Design — "Slew to target" via SharpCap (mount goto to the active object)

Branch: TBD
Status: **DESIGN / next TODO** — not implemented yet.
Milestone-Vorschlag: M87.

---

## 1. Goal

Let the app **drive the mount to the active sky object's RA/Dec** through the
existing SharpCap link, so selecting an object (or hitting a "Slew" button) both
**points the scope** and (already today) **arms the capture**. A natural
extension of the active-target workflow.

**It slews to the OBJECT** (planet / star / DSO) — never to the aircraft or
satellite (those move at degrees/second; no mount can blind-track them). The
object is the fixed RA/Dec we frame; the fast mover crosses that frame.

## 2. Hard constraints (from the user — non-negotiable)

- **Night targets only. NEVER the Sun.** An autonomous slew toward the Sun is a
  safety hazard (no filter / pier crash). The Sun (and arguably daytime) is hard-
  blocked; only objects observable in darkness are slew-able.
- **Via SharpCap commands** (`SharpCap.Mounts` scripting API in the listener) —
  **not** a direct ASCOM `Telescope` dispatch. Keep it inside SharpCap's own
  mount handling.
- **A general enable/disable setting in the UI** — the whole feature is opt-in
  and off by default.
- **No polar alignment / no plate-solving in this step.** PA "geht eh nicht so
  schnell" and is out of scope. The mount is slewed **blind** to RA/Dec.
- **The user is responsible** for an accurate-enough mount and that a **polar
  alignment already exists** (done manually beforehand).
- **FOV framing is only as good as the polar alignment** — surface this clearly
  in the UI: a blind goto lands the object within the mount's pointing accuracy,
  which depends on the user's PA. If they want the object centred, they PA first.

## 3. How it works

The listener (`scripts/sharpcap/trigger_listener.py`, runs inside SharpCap's
Python console) already accepts a JSON-over-TCP command to arm a capture. Extend
the protocol with a **slew command**:

```jsonc
// server → listener
{ "cmd": "slew", "raHours": 5.588, "decDeg": -5.391, "token": "…" }
```

Listener handling (SharpCap API, not raw ASCOM):
- Resolve the selected mount: `SharpCap.Mounts.SelectedMount` (reject if none).
- Issue the slew via SharpCap's mount object (the SharpCap scripting equivalent
  of `SlewToCoordinates(raHours, decDeg)`). Async if available; report back
  `{ ok, slewing }` or an error.
- The server sends the **active object's RA/Dec**, which we already have: the
  catalogue carries J2000 RA/Dec for stars/DSO; planets/Moon come from the
  ephemeris (`geometry.bodyAzEl` / equatorial helpers). Sun is excluded.

Server side: a `SharpCapTrigger.slewTo({ raHours, decDeg })` method that reuses
the same `_sendPayload` socket path (separate from `armForCandidate` /
`armForSkyTarget` — it's a different command, not the safety-critical capture
arming). A new endpoint `POST /api/slew` (or fold into `/api/active-target` with
a `slew: true` flag).

## 4. Safety gates (server-enforced, before anything is sent)

1. **Never the Sun.** Reject `target.id === 'sun'` / `body === 'Sun'` outright.
2. **Object must be observable in darkness:** above a min elevation AND the sky
   dark enough (Sun below e.g. −6° to −12°) — i.e. it's actually night and the
   object is up. No daytime slews.
3. **Feature enabled** (the UI master switch) AND a SharpCap host is configured.
4. **Explicit action** — slew on a deliberate "Slew to target" button / a
   confirmed active-target change, never a silent auto-slew on every tick.

## 5. UI

- A master **enable/disable** toggle (Settings → Scopes): "Allow mount slew via
  SharpCap (night objects only)". Off by default, with the PA caveat spelled out.
- A **"🔭 Slew to <object>"** button next to the active-target pulldown (shown
  only when the feature is enabled, a SharpCap host is set, and the selected
  object is a night object — greyed/hidden for Sun). On click → `POST /api/slew`
  with the object's RA/Dec → toast the result ("slewing…", "no mount", error).
- A one-line caveat near the control: *"Framing accuracy = your polar alignment.
  PA the mount manually first."*

## 6. Non-goals (explicitly out of scope here)

- **No polar alignment routine.**
- **No plate-solve-and-centre** (a later, bigger step if blind goto proves too
  rough — SharpCap can plate-solve, but that's a separate feature).
- **No tracking the aircraft/satellite** — only the fixed object is slewed to.
- **No Sun / daytime slewing**, ever.

## 7. Plan (when picked up)

- [ ] Listener: handle `{ cmd: 'slew', raHours, decDeg }` via `SharpCap.Mounts`
      (reject if no selected mount); reply `{ ok, slewing|error }`.
- [ ] `sharpcap.js`: `slewTo({ raHours, decDeg })` reusing `_sendPayload`.
- [ ] service: derive the active object's RA/Dec (catalogue for star/DSO,
      ephemeris for planets/Moon; Sun excluded); safety gates (§4); endpoint
      `POST /api/slew`; config `sharpcap.allowSlew` (or `slew.enabled`).
- [ ] web: enable toggle (Scopes tab) + "Slew to <object>" button by the
      active-target pulldown + the PA-accuracy caveat; result toast.
- [ ] Tests: slewTo payload shape; safety gates reject Sun / daytime / disabled /
      no-host; RA/Dec derivation for a star vs a planet.
- [ ] Docs: README/wiki note + MILESTONES; the PA-accuracy caveat.

## 8. Open questions

- Endpoint: dedicated `POST /api/slew { target }` vs a `slew` flag on the
  active-target POST? (Leaning dedicated — slew is a distinct, heavier action.)
- Min Sun-depth for "dark enough to slew" — reuse `iss.skyTargets.sunBelowDeg`
  (−6) or its own knob?
- Should selecting a night active-target **optionally auto-slew** (with a
  confirm), or strictly a manual button? (User said manual/no silent auto — keep
  it a button; an opt-in "auto-slew on select" could come later.)
- Listener: does the installed SharpCap build expose a slew method on
  `SharpCap.Mounts.SelectedMount`, or only connect/disconnect? Verify against the
  SharpCap scripting API on the user's version before wiring (fallback: surface
  "mount slew not supported by this SharpCap build").
