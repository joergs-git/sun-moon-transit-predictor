// Curated catalogue of attractive sky targets for satellite-pass prediction
// (M83). The brightest stars and the largest / brightest deep-sky objects
// across BOTH hemispheres, plus the bright planets — the things worth framing
// for an "ISS / HST / Tiangong crosses my field" shot.
//
// Coordinates are J2000 (RA in decimal hours, Dec in decimal degrees); the
// astronomy engine precesses them to date. `diameterDeg` is the object's
// apparent size (extended objects only; stars/planets omit it — a star is a
// point, a planet's disc is computed from its ephemeris). The predictor's
// elevation gate automatically hides whatever never rises for the observer, so
// a single combined N+S list is correct at any latitude.
//
// Trim or extend this in config/service.json (iss.skyTargets.objects) — this
// is just the default. More objects = a slightly longer scan on the (slow)
// recompute, so it is a curated ~top list rather than a full catalogue.

export const DEFAULT_SKY_TARGETS = [
  // ── Brightest stars (apparent magnitude order, both hemispheres) ──────────
  { id: 'sirius',     name: 'Sirius (α CMa)',      raHours: 6.7525,  decDeg: -16.7161 },
  { id: 'canopus',    name: 'Canopus (α Car)',     raHours: 6.3992,  decDeg: -52.6957 },
  { id: 'rigil-kent', name: 'Rigil Kent. (α Cen)', raHours: 14.6600, decDeg: -60.8340 },
  { id: 'arcturus',   name: 'Arcturus (α Boo)',    raHours: 14.2610, decDeg: 19.1825 },
  { id: 'vega',       name: 'Vega (α Lyr)',        raHours: 18.6156, decDeg: 38.7837 },
  { id: 'capella',    name: 'Capella (α Aur)',     raHours: 5.2782,  decDeg: 45.9980 },
  { id: 'rigel',      name: 'Rigel (β Ori)',       raHours: 5.2423,  decDeg: -8.2016 },
  { id: 'procyon',    name: 'Procyon (α CMi)',     raHours: 7.6550,  decDeg: 5.2250 },
  { id: 'achernar',   name: 'Achernar (α Eri)',    raHours: 1.6286,  decDeg: -57.2367 },
  { id: 'betelgeuse', name: 'Betelgeuse (α Ori)',  raHours: 5.9195,  decDeg: 7.4071 },
  { id: 'hadar',      name: 'Hadar (β Cen)',       raHours: 14.0637, decDeg: -60.3730 },
  { id: 'altair',     name: 'Altair (α Aql)',      raHours: 19.8464, decDeg: 8.8683 },
  { id: 'acrux',      name: 'Acrux (α Cru)',       raHours: 12.4433, decDeg: -63.0991 },
  { id: 'aldebaran',  name: 'Aldebaran (α Tau)',   raHours: 4.5987,  decDeg: 16.5093 },
  { id: 'antares',    name: 'Antares (α Sco)',     raHours: 16.4901, decDeg: -26.4320 },
  { id: 'spica',      name: 'Spica (α Vir)',       raHours: 13.4199, decDeg: -11.1613 },
  { id: 'pollux',     name: 'Pollux (β Gem)',      raHours: 7.7553,  decDeg: 28.0262 },
  { id: 'fomalhaut',  name: 'Fomalhaut (α PsA)',   raHours: 22.9608, decDeg: -29.6222 },
  { id: 'deneb',      name: 'Deneb (α Cyg)',       raHours: 20.6905, decDeg: 45.2803 },
  { id: 'regulus',    name: 'Regulus (α Leo)',     raHours: 10.1395, decDeg: 11.9672 },

  // ── Brightest / largest deep-sky objects (both hemispheres) ───────────────
  { id: 'lmc',  name: 'Large Magellanic Cloud', raHours: 5.3925,  decDeg: -69.7561, diameterDeg: 5.0 },
  { id: 'smc',  name: 'Small Magellanic Cloud', raHours: 0.8767,  decDeg: -72.8003, diameterDeg: 3.0 },
  { id: 'hyades', name: 'Hyades',               raHours: 4.4500,  decDeg: 15.8700,  diameterDeg: 5.0 },
  { id: 'm31',  name: 'M31 Andromeda',          raHours: 0.7123,  decDeg: 41.2690,  diameterDeg: 3.0 },
  { id: 'm45',  name: 'M45 Pleiades',           raHours: 3.7833,  decDeg: 24.1167,  diameterDeg: 2.0 },
  { id: 'eta-car', name: 'η Carinae Nebula',    raHours: 10.7517, decDeg: -59.8667, diameterDeg: 2.0 },
  { id: 'm24',  name: 'M24 Sgr Star Cloud',     raHours: 18.2817, decDeg: -18.5500, diameterDeg: 1.5 },
  { id: 'm44',  name: 'M44 Beehive',            raHours: 8.6700,  decDeg: 19.6700,  diameterDeg: 1.5 },
  { id: 'm7',   name: 'M7 Ptolemy Cluster',     raHours: 17.8967, decDeg: -34.7933, diameterDeg: 1.3 },
  { id: 'm42',  name: 'M42 Orion Nebula',       raHours: 5.5881,  decDeg: -5.3911,  diameterDeg: 1.0 },
  { id: 'dbl-cluster', name: 'Double Cluster',  raHours: 2.3167,  decDeg: 57.1367,  diameterDeg: 1.0 },
  { id: 'm8',   name: 'M8 Lagoon Nebula',       raHours: 18.0606, decDeg: -24.3867, diameterDeg: 0.75 },
  { id: 'omega-cen', name: 'ω Centauri (NGC 5139)', raHours: 13.4467, decDeg: -47.4783, diameterDeg: 0.6 },
  { id: '47tuc', name: '47 Tucanae (NGC 104)',  raHours: 0.4017,  decDeg: -72.0814, diameterDeg: 0.5 },
  { id: 'm22',  name: 'M22 Sgr Cluster',        raHours: 18.6067, decDeg: -23.9050, diameterDeg: 0.4 },
  { id: 'm6',   name: 'M6 Butterfly Cluster',   raHours: 17.6683, decDeg: -32.2417, diameterDeg: 0.4 },
  { id: 'm13',  name: 'M13 Hercules Cluster',   raHours: 16.6949, decDeg: 36.4613,  diameterDeg: 0.33 },
  { id: 'm11',  name: 'M11 Wild Duck',          raHours: 18.8511, decDeg: -6.2700,  diameterDeg: 0.23 },
  { id: 'm51',  name: 'M51 Whirlpool',          raHours: 13.4978, decDeg: 47.1953,  diameterDeg: 0.18 },
  { id: 'm104', name: 'M104 Sombrero',          raHours: 12.6667, decDeg: -11.6233, diameterDeg: 0.15 },

  // ── Bright planets (live ephemeris; disc computed by the predictor) ────────
  { id: 'jupiter', name: 'Jupiter', body: 'Jupiter' },
  { id: 'saturn',  name: 'Saturn',  body: 'Saturn' },
  { id: 'mars',    name: 'Mars',    body: 'Mars' },
  { id: 'venus',   name: 'Venus',   body: 'Venus' },
];
