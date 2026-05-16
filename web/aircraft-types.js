// Offline aircraft-type specs.
//
// Maps an ICAO type designator (the `t` field dump1090-fa publishes when its
// aircraft database is loaded — e.g. "A320", "B738") to nominal published
// dimensions. Values are manufacturer headline figures rounded to one
// decimal; they drive (a) the spec block beside the FOV preview and (b) a
// more faithful silhouette scale in the sketch. They are intentionally
// approximate — the sketch's visual fidelity is well below the variation
// between sub-variants, and the labels always carry the measured geometry.
//
// No network, no photos: this is a static table so the Pi deployment keeps
// working fully offline. Unknown type codes degrade gracefully to null and
// the UI falls back to the generic ~A320 envelope it used before.
//
// `firstYear` is the first-delivery year of the family — it gives the user a
// rough "how old is this airframe design" cue without us needing a per-tail
// build-year database (which ADS-B does not carry anyway).

/**
 * @typedef {Object} AircraftSpec
 * @property {string} manufacturer
 * @property {string} model
 * @property {number} lengthM       - overall length, metres
 * @property {number} wingspanM     - wingspan, metres
 * @property {number} mtowKg        - max take-off weight, kg
 * @property {number|null} seats    - typical 2-class seating (null for non-pax)
 * @property {number} firstYear     - first-delivery year of the family
 * @property {'narrowbody'|'widebody'|'regional'|'turboprop'|'business'|'ga'|'military'|'cargo'} klass
 */

/** @type {Record<string, AircraftSpec>} */
export const AIRCRAFT_TYPES = {
  // ---- Airbus narrowbody ----
  A318: { manufacturer: 'Airbus', model: 'A318',        lengthM: 31.4, wingspanM: 34.1, mtowKg: 68000,  seats: 107, firstYear: 2003, klass: 'narrowbody' },
  A319: { manufacturer: 'Airbus', model: 'A319',        lengthM: 33.8, wingspanM: 35.8, mtowKg: 75500,  seats: 124, firstYear: 1996, klass: 'narrowbody' },
  A320: { manufacturer: 'Airbus', model: 'A320',        lengthM: 37.6, wingspanM: 35.8, mtowKg: 78000,  seats: 150, firstYear: 1988, klass: 'narrowbody' },
  A321: { manufacturer: 'Airbus', model: 'A321',        lengthM: 44.5, wingspanM: 35.8, mtowKg: 93500,  seats: 185, firstYear: 1994, klass: 'narrowbody' },
  A19N: { manufacturer: 'Airbus', model: 'A319neo',     lengthM: 33.8, wingspanM: 35.8, mtowKg: 75500,  seats: 124, firstYear: 2019, klass: 'narrowbody' },
  A20N: { manufacturer: 'Airbus', model: 'A320neo',     lengthM: 37.6, wingspanM: 35.8, mtowKg: 79000,  seats: 165, firstYear: 2016, klass: 'narrowbody' },
  A21N: { manufacturer: 'Airbus', model: 'A321neo',     lengthM: 44.5, wingspanM: 35.8, mtowKg: 97000,  seats: 206, firstYear: 2017, klass: 'narrowbody' },
  // ---- Airbus widebody ----
  A306: { manufacturer: 'Airbus', model: 'A300-600',    lengthM: 54.1, wingspanM: 44.8, mtowKg: 171700, seats: 266, firstYear: 1984, klass: 'widebody' },
  A310: { manufacturer: 'Airbus', model: 'A310',        lengthM: 46.7, wingspanM: 43.9, mtowKg: 164000, seats: 220, firstYear: 1983, klass: 'widebody' },
  A332: { manufacturer: 'Airbus', model: 'A330-200',    lengthM: 58.8, wingspanM: 60.3, mtowKg: 242000, seats: 247, firstYear: 1998, klass: 'widebody' },
  A333: { manufacturer: 'Airbus', model: 'A330-300',    lengthM: 63.7, wingspanM: 60.3, mtowKg: 242000, seats: 277, firstYear: 1994, klass: 'widebody' },
  A338: { manufacturer: 'Airbus', model: 'A330-800neo', lengthM: 58.8, wingspanM: 64.0, mtowKg: 251000, seats: 257, firstYear: 2020, klass: 'widebody' },
  A339: { manufacturer: 'Airbus', model: 'A330-900neo', lengthM: 63.7, wingspanM: 64.0, mtowKg: 251000, seats: 287, firstYear: 2018, klass: 'widebody' },
  A342: { manufacturer: 'Airbus', model: 'A340-200',    lengthM: 59.4, wingspanM: 60.3, mtowKg: 275000, seats: 261, firstYear: 1993, klass: 'widebody' },
  A343: { manufacturer: 'Airbus', model: 'A340-300',    lengthM: 63.7, wingspanM: 60.3, mtowKg: 276500, seats: 295, firstYear: 1993, klass: 'widebody' },
  A346: { manufacturer: 'Airbus', model: 'A340-600',    lengthM: 75.4, wingspanM: 63.5, mtowKg: 380000, seats: 326, firstYear: 2002, klass: 'widebody' },
  A359: { manufacturer: 'Airbus', model: 'A350-900',    lengthM: 66.8, wingspanM: 64.8, mtowKg: 280000, seats: 315, firstYear: 2014, klass: 'widebody' },
  A35K: { manufacturer: 'Airbus', model: 'A350-1000',   lengthM: 73.8, wingspanM: 64.8, mtowKg: 319000, seats: 369, firstYear: 2018, klass: 'widebody' },
  A388: { manufacturer: 'Airbus', model: 'A380-800',    lengthM: 72.7, wingspanM: 79.8, mtowKg: 575000, seats: 525, firstYear: 2007, klass: 'widebody' },
  // ---- Boeing narrowbody ----
  B712: { manufacturer: 'Boeing', model: '717-200',     lengthM: 37.8, wingspanM: 28.4, mtowKg: 54900,  seats: 110, firstYear: 1999, klass: 'narrowbody' },
  B733: { manufacturer: 'Boeing', model: '737-300',     lengthM: 33.4, wingspanM: 28.9, mtowKg: 62800,  seats: 140, firstYear: 1984, klass: 'narrowbody' },
  B734: { manufacturer: 'Boeing', model: '737-400',     lengthM: 36.4, wingspanM: 28.9, mtowKg: 68000,  seats: 159, firstYear: 1988, klass: 'narrowbody' },
  B735: { manufacturer: 'Boeing', model: '737-500',     lengthM: 31.0, wingspanM: 28.9, mtowKg: 60600,  seats: 122, firstYear: 1990, klass: 'narrowbody' },
  B736: { manufacturer: 'Boeing', model: '737-600',     lengthM: 31.2, wingspanM: 34.3, mtowKg: 65500,  seats: 119, firstYear: 1998, klass: 'narrowbody' },
  B737: { manufacturer: 'Boeing', model: '737-700',     lengthM: 33.6, wingspanM: 34.3, mtowKg: 70080,  seats: 126, firstYear: 1997, klass: 'narrowbody' },
  B738: { manufacturer: 'Boeing', model: '737-800',     lengthM: 39.5, wingspanM: 34.3, mtowKg: 79010,  seats: 162, firstYear: 1998, klass: 'narrowbody' },
  B739: { manufacturer: 'Boeing', model: '737-900',     lengthM: 42.1, wingspanM: 34.3, mtowKg: 79010,  seats: 178, firstYear: 2001, klass: 'narrowbody' },
  B37M: { manufacturer: 'Boeing', model: '737 MAX 7',   lengthM: 35.6, wingspanM: 35.9, mtowKg: 80300,  seats: 138, firstYear: 2022, klass: 'narrowbody' },
  B38M: { manufacturer: 'Boeing', model: '737 MAX 8',   lengthM: 39.5, wingspanM: 35.9, mtowKg: 82200,  seats: 178, firstYear: 2017, klass: 'narrowbody' },
  B39M: { manufacturer: 'Boeing', model: '737 MAX 9',   lengthM: 42.2, wingspanM: 35.9, mtowKg: 88300,  seats: 193, firstYear: 2018, klass: 'narrowbody' },
  B752: { manufacturer: 'Boeing', model: '757-200',     lengthM: 47.3, wingspanM: 38.0, mtowKg: 115680, seats: 200, firstYear: 1983, klass: 'narrowbody' },
  B753: { manufacturer: 'Boeing', model: '757-300',     lengthM: 54.4, wingspanM: 38.0, mtowKg: 123600, seats: 243, firstYear: 1999, klass: 'narrowbody' },
  // ---- Boeing widebody ----
  B762: { manufacturer: 'Boeing', model: '767-200',     lengthM: 48.5, wingspanM: 47.6, mtowKg: 142880, seats: 216, firstYear: 1982, klass: 'widebody' },
  B763: { manufacturer: 'Boeing', model: '767-300',     lengthM: 54.9, wingspanM: 47.6, mtowKg: 186880, seats: 269, firstYear: 1986, klass: 'widebody' },
  B764: { manufacturer: 'Boeing', model: '767-400',     lengthM: 61.4, wingspanM: 51.9, mtowKg: 204120, seats: 296, firstYear: 2000, klass: 'widebody' },
  B772: { manufacturer: 'Boeing', model: '777-200',     lengthM: 63.7, wingspanM: 60.9, mtowKg: 247200, seats: 313, firstYear: 1995, klass: 'widebody' },
  B77L: { manufacturer: 'Boeing', model: '777-200LR',   lengthM: 63.7, wingspanM: 64.8, mtowKg: 347800, seats: 317, firstYear: 2006, klass: 'widebody' },
  B77W: { manufacturer: 'Boeing', model: '777-300ER',   lengthM: 73.9, wingspanM: 64.8, mtowKg: 351500, seats: 396, firstYear: 2004, klass: 'widebody' },
  B778: { manufacturer: 'Boeing', model: '777-8',       lengthM: 69.8, wingspanM: 71.8, mtowKg: 351500, seats: 395, firstYear: 2025, klass: 'widebody' },
  B779: { manufacturer: 'Boeing', model: '777-9',       lengthM: 76.7, wingspanM: 71.8, mtowKg: 351500, seats: 426, firstYear: 2025, klass: 'widebody' },
  B741: { manufacturer: 'Boeing', model: '747-100',     lengthM: 70.7, wingspanM: 59.6, mtowKg: 333400, seats: 366, firstYear: 1970, klass: 'widebody' },
  B744: { manufacturer: 'Boeing', model: '747-400',     lengthM: 70.7, wingspanM: 64.4, mtowKg: 396890, seats: 416, firstYear: 1989, klass: 'widebody' },
  B748: { manufacturer: 'Boeing', model: '747-8',       lengthM: 76.3, wingspanM: 68.4, mtowKg: 447700, seats: 410, firstYear: 2012, klass: 'widebody' },
  B788: { manufacturer: 'Boeing', model: '787-8',       lengthM: 56.7, wingspanM: 60.1, mtowKg: 227930, seats: 248, firstYear: 2011, klass: 'widebody' },
  B789: { manufacturer: 'Boeing', model: '787-9',       lengthM: 62.8, wingspanM: 60.1, mtowKg: 254000, seats: 296, firstYear: 2014, klass: 'widebody' },
  B78X: { manufacturer: 'Boeing', model: '787-10',      lengthM: 68.3, wingspanM: 60.1, mtowKg: 254000, seats: 336, firstYear: 2018, klass: 'widebody' },
  // ---- Regional jets / props ----
  E170: { manufacturer: 'Embraer', model: 'E170',       lengthM: 29.9, wingspanM: 26.0, mtowKg: 38600,  seats: 76,  firstYear: 2004, klass: 'regional' },
  E75L: { manufacturer: 'Embraer', model: 'E175',       lengthM: 31.7, wingspanM: 26.0, mtowKg: 38790,  seats: 88,  firstYear: 2005, klass: 'regional' },
  E190: { manufacturer: 'Embraer', model: 'E190',       lengthM: 36.2, wingspanM: 28.7, mtowKg: 51800,  seats: 100, firstYear: 2005, klass: 'regional' },
  E195: { manufacturer: 'Embraer', model: 'E195',       lengthM: 38.7, wingspanM: 28.7, mtowKg: 52290,  seats: 116, firstYear: 2006, klass: 'regional' },
  E290: { manufacturer: 'Embraer', model: 'E190-E2',    lengthM: 36.2, wingspanM: 33.7, mtowKg: 56400,  seats: 106, firstYear: 2018, klass: 'regional' },
  E295: { manufacturer: 'Embraer', model: 'E195-E2',    lengthM: 41.5, wingspanM: 35.1, mtowKg: 61500,  seats: 132, firstYear: 2019, klass: 'regional' },
  CRJ2: { manufacturer: 'Bombardier', model: 'CRJ200',  lengthM: 26.8, wingspanM: 21.2, mtowKg: 23133,  seats: 50,  firstYear: 1996, klass: 'regional' },
  CRJ7: { manufacturer: 'Bombardier', model: 'CRJ700',  lengthM: 32.5, wingspanM: 23.2, mtowKg: 34019,  seats: 70,  firstYear: 2001, klass: 'regional' },
  CRJ9: { manufacturer: 'Bombardier', model: 'CRJ900',  lengthM: 36.4, wingspanM: 24.9, mtowKg: 38330,  seats: 88,  firstYear: 2003, klass: 'regional' },
  CRJX: { manufacturer: 'Bombardier', model: 'CRJ1000', lengthM: 39.1, wingspanM: 26.2, mtowKg: 41640,  seats: 100, firstYear: 2010, klass: 'regional' },
  AT43: { manufacturer: 'ATR', model: 'ATR 42-300',     lengthM: 22.7, wingspanM: 24.6, mtowKg: 16700,  seats: 48,  firstYear: 1985, klass: 'turboprop' },
  AT72: { manufacturer: 'ATR', model: 'ATR 72',         lengthM: 27.2, wingspanM: 27.1, mtowKg: 22800,  seats: 70,  firstYear: 1989, klass: 'turboprop' },
  AT76: { manufacturer: 'ATR', model: 'ATR 72-600',     lengthM: 27.2, wingspanM: 27.1, mtowKg: 23000,  seats: 72,  firstYear: 2011, klass: 'turboprop' },
  DH8D: { manufacturer: 'De Havilland', model: 'Dash 8 Q400', lengthM: 32.8, wingspanM: 28.4, mtowKg: 29574, seats: 78, firstYear: 1999, klass: 'turboprop' },
  SF34: { manufacturer: 'Saab', model: '340',           lengthM: 19.7, wingspanM: 21.4, mtowKg: 13155,  seats: 34,  firstYear: 1984, klass: 'turboprop' },
  B463: { manufacturer: 'BAe', model: '146-300/Avro RJ', lengthM: 31.0, wingspanM: 26.3, mtowKg: 44225, seats: 100, firstYear: 1988, klass: 'regional' },
  // ---- Business jets ----
  GLF6: { manufacturer: 'Gulfstream', model: 'G650',    lengthM: 30.4, wingspanM: 30.4, mtowKg: 45178,  seats: 18,  firstYear: 2012, klass: 'business' },
  GLEX: { manufacturer: 'Bombardier', model: 'Global Express', lengthM: 30.3, wingspanM: 28.7, mtowKg: 45132, seats: 17, firstYear: 1999, klass: 'business' },
  CL60: { manufacturer: 'Bombardier', model: 'Challenger 600', lengthM: 20.9, wingspanM: 19.6, mtowKg: 21863, seats: 12, firstYear: 1980, klass: 'business' },
  C56X: { manufacturer: 'Cessna', model: 'Citation Excel', lengthM: 15.8, wingspanM: 17.2, mtowKg: 9163, seats: 9, firstYear: 1998, klass: 'business' },
  C25A: { manufacturer: 'Cessna', model: 'Citation CJ2', lengthM: 14.4, wingspanM: 15.5, mtowKg: 5670,  seats: 7,   firstYear: 2000, klass: 'business' },
  E55P: { manufacturer: 'Embraer', model: 'Phenom 300', lengthM: 15.9, wingspanM: 16.2, mtowKg: 8150,   seats: 9,   firstYear: 2009, klass: 'business' },
  PC12: { manufacturer: 'Pilatus', model: 'PC-12',      lengthM: 14.4, wingspanM: 16.3, mtowKg: 4740,   seats: 9,   firstYear: 1994, klass: 'turboprop' },
  // ---- General aviation ----
  C172: { manufacturer: 'Cessna', model: '172 Skyhawk', lengthM: 8.3,  wingspanM: 11.0, mtowKg: 1157,   seats: 4,   firstYear: 1956, klass: 'ga' },
  C152: { manufacturer: 'Cessna', model: '152',         lengthM: 7.3,  wingspanM: 10.0, mtowKg: 757,    seats: 2,   firstYear: 1977, klass: 'ga' },
  P28A: { manufacturer: 'Piper', model: 'PA-28 Cherokee', lengthM: 7.3, wingspanM: 10.7, mtowKg: 1157,  seats: 4,   firstYear: 1961, klass: 'ga' },
  SR22: { manufacturer: 'Cirrus', model: 'SR22',        lengthM: 7.9,  wingspanM: 11.7, mtowKg: 1542,   seats: 4,   firstYear: 2001, klass: 'ga' },
  DA40: { manufacturer: 'Diamond', model: 'DA40',       lengthM: 8.1,  wingspanM: 11.9, mtowKg: 1280,   seats: 4,   firstYear: 1997, klass: 'ga' },
  DA42: { manufacturer: 'Diamond', model: 'DA42',       lengthM: 8.6,  wingspanM: 13.4, mtowKg: 1785,   seats: 4,   firstYear: 2004, klass: 'ga' },
  // ---- Military / cargo (commonly overflying Europe) ----
  A400: { manufacturer: 'Airbus', model: 'A400M Atlas', lengthM: 45.1, wingspanM: 42.4, mtowKg: 141000, seats: null, firstYear: 2013, klass: 'military' },
  C130: { manufacturer: 'Lockheed', model: 'C-130 Hercules', lengthM: 29.8, wingspanM: 40.4, mtowKg: 70300, seats: null, firstYear: 1956, klass: 'military' },
  C17:  { manufacturer: 'Boeing', model: 'C-17 Globemaster III', lengthM: 53.0, wingspanM: 51.8, mtowKg: 265350, seats: null, firstYear: 1995, klass: 'military' },
  K35R: { manufacturer: 'Boeing', model: 'KC-135 Stratotanker', lengthM: 41.5, wingspanM: 39.9, mtowKg: 146300, seats: null, firstYear: 1957, klass: 'military' },
};

// A few common variant designators that map onto an existing representative
// entry — keeps coverage useful without listing every permutation.
const ALIASES = {
  E75S: 'E75L', CR9: 'CRJ9', CR7: 'CRJ7', CR2: 'CRJ2',
  A310: 'A310', B752: 'B752',
};

/**
 * Resolve an ICAO type designator to its spec. Case-insensitive, tolerant of
 * the odd surrounding whitespace some feeds add. Returns null when unknown so
 * callers can fall back to the generic envelope.
 *
 * @param {string|null|undefined} typeCode
 * @returns {AircraftSpec|null}
 */
export function resolveAircraftType(typeCode) {
  if (!typeCode || typeof typeCode !== 'string') return null;
  const key = typeCode.trim().toUpperCase();
  const resolved = AIRCRAFT_TYPES[key] ?? AIRCRAFT_TYPES[ALIASES[key]] ?? null;
  return resolved;
}

const KLASS_LABEL = {
  narrowbody: 'narrow-body airliner',
  widebody: 'wide-body airliner',
  regional: 'regional jet',
  turboprop: 'turboprop',
  business: 'business jet',
  ga: 'general aviation',
  military: 'military',
  cargo: 'cargo',
};

/**
 * Human-readable design-age phrase. ADS-B has no per-tail build year, so we
 * describe the *type's* age relative to the current year — still a useful
 * "vintage vs. modern airframe" cue for the observer.
 *
 * @param {number} firstYear
 * @param {number} [nowYear]
 * @returns {string}
 */
export function designAgePhrase(firstYear, nowYear = new Date().getFullYear()) {
  if (!Number.isFinite(firstYear)) return '—';
  const age = nowYear - firstYear;
  if (age <= 0) return `brand-new design (${firstYear})`;
  return `design from ${firstYear} (~${age} yr old type)`;
}

export function klassLabel(klass) {
  return KLASS_LABEL[klass] ?? klass ?? '—';
}
