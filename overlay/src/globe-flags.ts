// Country flag rendering for globe.gl (Phase 2, Module A).
// Provides country center coordinates, flag overlay data for polygons, and emoji helpers.

/**
 * Center coordinates for all countries using ISO 3166-1 alpha-2 codes.
 * These are approximate geographic centers, not capitals.
 */
export const COUNTRY_CENTERS: Readonly<Record<string, { lat: number; lng: number }>> = {
  // ═══════════════════════════════════════════════════════════════════════════
  // NORTH AMERICA
  // ═══════════════════════════════════════════════════════════════════════════
  US: { lat: 39.8, lng: -98.6 },    // United States
  CA: { lat: 56.1, lng: -106.3 },   // Canada
  MX: { lat: 23.6, lng: -102.5 },   // Mexico
  GT: { lat: 15.8, lng: -90.2 },    // Guatemala
  BZ: { lat: 17.2, lng: -88.5 },    // Belize
  HN: { lat: 15.2, lng: -86.2 },    // Honduras
  SV: { lat: 13.8, lng: -88.9 },    // El Salvador
  NI: { lat: 12.9, lng: -85.2 },    // Nicaragua
  CR: { lat: 9.7, lng: -83.8 },     // Costa Rica
  PA: { lat: 8.5, lng: -80.8 },     // Panama

  // ═══════════════════════════════════════════════════════════════════════════
  // CARIBBEAN
  // ═══════════════════════════════════════════════════════════════════════════
  CU: { lat: 21.5, lng: -77.8 },    // Cuba
  JM: { lat: 18.1, lng: -77.3 },    // Jamaica
  HT: { lat: 18.9, lng: -72.3 },    // Haiti
  DO: { lat: 18.7, lng: -70.2 },    // Dominican Republic
  PR: { lat: 18.2, lng: -66.5 },    // Puerto Rico
  TT: { lat: 10.7, lng: -61.2 },    // Trinidad and Tobago
  BB: { lat: 13.2, lng: -59.5 },    // Barbados
  BS: { lat: 25.0, lng: -77.4 },    // Bahamas
  AG: { lat: 17.1, lng: -61.8 },    // Antigua and Barbuda
  DM: { lat: 15.4, lng: -61.4 },    // Dominica
  GD: { lat: 12.1, lng: -61.7 },    // Grenada
  KN: { lat: 17.4, lng: -62.8 },    // Saint Kitts and Nevis
  LC: { lat: 13.9, lng: -61.0 },    // Saint Lucia
  VC: { lat: 13.3, lng: -61.2 },    // Saint Vincent and the Grenadines
  AW: { lat: 12.5, lng: -69.9 },    // Aruba
  CW: { lat: 12.2, lng: -68.9 },    // Curaçao

  // ═══════════════════════════════════════════════════════════════════════════
  // SOUTH AMERICA
  // ═══════════════════════════════════════════════════════════════════════════
  BR: { lat: -10.3, lng: -53.2 },   // Brazil
  AR: { lat: -38.4, lng: -63.6 },   // Argentina
  CL: { lat: -35.7, lng: -71.5 },   // Chile
  CO: { lat: 4.6, lng: -74.3 },     // Colombia
  PE: { lat: -9.2, lng: -75.0 },    // Peru
  VE: { lat: 6.4, lng: -66.6 },     // Venezuela
  EC: { lat: -1.8, lng: -78.2 },    // Ecuador
  BO: { lat: -16.3, lng: -63.6 },   // Bolivia
  PY: { lat: -23.4, lng: -58.4 },   // Paraguay
  UY: { lat: -32.5, lng: -55.8 },   // Uruguay
  GY: { lat: 4.9, lng: -58.9 },     // Guyana
  SR: { lat: 3.9, lng: -56.0 },     // Suriname
  GF: { lat: 3.9, lng: -53.1 },     // French Guiana

  // ═══════════════════════════════════════════════════════════════════════════
  // WESTERN EUROPE
  // ═══════════════════════════════════════════════════════════════════════════
  GB: { lat: 55.4, lng: -3.4 },     // United Kingdom
  FR: { lat: 46.6, lng: 2.4 },      // France
  DE: { lat: 51.2, lng: 10.4 },     // Germany
  ES: { lat: 40.5, lng: -3.7 },     // Spain
  IT: { lat: 41.9, lng: 12.6 },     // Italy
  PT: { lat: 39.4, lng: -8.2 },     // Portugal
  NL: { lat: 52.1, lng: 5.3 },      // Netherlands
  BE: { lat: 50.5, lng: 4.5 },      // Belgium
  AT: { lat: 47.5, lng: 14.6 },     // Austria
  CH: { lat: 46.8, lng: 8.2 },      // Switzerland
  IE: { lat: 53.4, lng: -8.2 },     // Ireland
  LU: { lat: 49.8, lng: 6.1 },      // Luxembourg
  MC: { lat: 43.7, lng: 7.4 },      // Monaco
  LI: { lat: 47.2, lng: 9.6 },      // Liechtenstein
  AD: { lat: 42.5, lng: 1.5 },      // Andorra
  SM: { lat: 43.9, lng: 12.5 },     // San Marino
  VA: { lat: 41.9, lng: 12.5 },     // Vatican City
  MT: { lat: 35.9, lng: 14.5 },     // Malta

  // ═══════════════════════════════════════════════════════════════════════════
  // NORTHERN EUROPE / SCANDINAVIA
  // ═══════════════════════════════════════════════════════════════════════════
  SE: { lat: 60.1, lng: 18.6 },     // Sweden
  NO: { lat: 60.5, lng: 8.5 },      // Norway
  FI: { lat: 61.9, lng: 25.7 },     // Finland
  DK: { lat: 56.3, lng: 9.5 },      // Denmark
  IS: { lat: 65.0, lng: -19.0 },    // Iceland
  EE: { lat: 58.6, lng: 25.0 },     // Estonia
  LV: { lat: 56.9, lng: 24.6 },     // Latvia
  LT: { lat: 55.2, lng: 23.9 },     // Lithuania

  // ═══════════════════════════════════════════════════════════════════════════
  // EASTERN EUROPE
  // ═══════════════════════════════════════════════════════════════════════════
  PL: { lat: 51.9, lng: 19.1 },     // Poland
  CZ: { lat: 49.8, lng: 15.5 },     // Czech Republic
  SK: { lat: 48.7, lng: 19.7 },     // Slovakia
  HU: { lat: 47.2, lng: 19.5 },     // Hungary
  RO: { lat: 45.9, lng: 25.0 },     // Romania
  BG: { lat: 42.7, lng: 25.5 },     // Bulgaria
  UA: { lat: 48.4, lng: 31.2 },     // Ukraine
  BY: { lat: 53.7, lng: 27.9 },     // Belarus
  MD: { lat: 47.4, lng: 28.4 },     // Moldova
  RU: { lat: 61.5, lng: 105.3 },    // Russia

  // ═══════════════════════════════════════════════════════════════════════════
  // BALKANS
  // ═══════════════════════════════════════════════════════════════════════════
  GR: { lat: 39.1, lng: 21.8 },     // Greece
  HR: { lat: 45.1, lng: 15.2 },     // Croatia
  RS: { lat: 44.0, lng: 21.0 },     // Serbia
  SI: { lat: 46.2, lng: 14.9 },     // Slovenia
  BA: { lat: 43.9, lng: 17.7 },     // Bosnia and Herzegovina
  MK: { lat: 41.5, lng: 21.7 },     // North Macedonia
  ME: { lat: 42.7, lng: 19.4 },     // Montenegro
  AL: { lat: 41.2, lng: 20.2 },     // Albania
  XK: { lat: 42.6, lng: 20.9 },     // Kosovo
  CY: { lat: 35.1, lng: 33.4 },     // Cyprus

  // ═══════════════════════════════════════════════════════════════════════════
  // MIDDLE EAST
  // ═══════════════════════════════════════════════════════════════════════════
  TR: { lat: 38.9, lng: 35.2 },     // Turkey
  IL: { lat: 31.0, lng: 34.9 },     // Israel
  PS: { lat: 31.9, lng: 35.2 },     // Palestine
  JO: { lat: 30.6, lng: 36.2 },     // Jordan
  LB: { lat: 33.9, lng: 35.9 },     // Lebanon
  SY: { lat: 34.8, lng: 39.0 },     // Syria
  IQ: { lat: 33.2, lng: 43.7 },     // Iraq
  IR: { lat: 32.4, lng: 53.7 },     // Iran
  SA: { lat: 23.9, lng: 45.1 },     // Saudi Arabia
  AE: { lat: 23.4, lng: 53.8 },     // United Arab Emirates
  QA: { lat: 25.4, lng: 51.2 },     // Qatar
  BH: { lat: 26.0, lng: 50.5 },     // Bahrain
  KW: { lat: 29.3, lng: 47.5 },     // Kuwait
  OM: { lat: 21.5, lng: 55.9 },     // Oman
  YE: { lat: 15.6, lng: 48.5 },     // Yemen

  // ═══════════════════════════════════════════════════════════════════════════
  // CENTRAL ASIA
  // ═══════════════════════════════════════════════════════════════════════════
  KZ: { lat: 48.0, lng: 67.3 },     // Kazakhstan
  UZ: { lat: 41.4, lng: 64.6 },     // Uzbekistan
  TM: { lat: 38.9, lng: 59.6 },     // Turkmenistan
  TJ: { lat: 38.9, lng: 71.3 },     // Tajikistan
  KG: { lat: 41.2, lng: 74.8 },     // Kyrgyzstan
  AF: { lat: 33.9, lng: 67.7 },     // Afghanistan

  // ═══════════════════════════════════════════════════════════════════════════
  // SOUTH ASIA
  // ═══════════════════════════════════════════════════════════════════════════
  IN: { lat: 20.6, lng: 79.0 },     // India
  PK: { lat: 30.4, lng: 69.3 },     // Pakistan
  BD: { lat: 23.7, lng: 90.4 },     // Bangladesh
  LK: { lat: 7.9, lng: 80.8 },      // Sri Lanka
  NP: { lat: 28.4, lng: 84.1 },     // Nepal
  BT: { lat: 27.5, lng: 90.4 },     // Bhutan
  MV: { lat: 3.2, lng: 73.2 },      // Maldives

  // ═══════════════════════════════════════════════════════════════════════════
  // EAST ASIA
  // ═══════════════════════════════════════════════════════════════════════════
  CN: { lat: 35.9, lng: 104.2 },    // China
  JP: { lat: 36.2, lng: 138.3 },    // Japan
  KR: { lat: 36.5, lng: 127.9 },    // South Korea
  KP: { lat: 40.3, lng: 127.5 },    // North Korea
  MN: { lat: 46.9, lng: 103.8 },    // Mongolia
  TW: { lat: 23.7, lng: 121.0 },    // Taiwan
  HK: { lat: 22.4, lng: 114.1 },    // Hong Kong
  MO: { lat: 22.2, lng: 113.5 },    // Macau

  // ═══════════════════════════════════════════════════════════════════════════
  // SOUTHEAST ASIA
  // ═══════════════════════════════════════════════════════════════════════════
  TH: { lat: 15.9, lng: 100.9 },    // Thailand
  VN: { lat: 14.1, lng: 108.3 },    // Vietnam
  MY: { lat: 4.2, lng: 101.9 },     // Malaysia
  SG: { lat: 1.4, lng: 103.8 },     // Singapore
  ID: { lat: -0.8, lng: 113.9 },    // Indonesia
  PH: { lat: 12.9, lng: 121.8 },    // Philippines
  MM: { lat: 21.9, lng: 95.9 },     // Myanmar
  KH: { lat: 12.6, lng: 105.0 },    // Cambodia
  LA: { lat: 19.9, lng: 102.5 },    // Laos
  BN: { lat: 4.5, lng: 114.7 },     // Brunei
  TL: { lat: -8.9, lng: 125.7 },    // Timor-Leste

  // ═══════════════════════════════════════════════════════════════════════════
  // OCEANIA
  // ═══════════════════════════════════════════════════════════════════════════
  AU: { lat: -25.3, lng: 133.8 },   // Australia
  NZ: { lat: -40.9, lng: 174.9 },   // New Zealand
  FJ: { lat: -17.7, lng: 178.1 },   // Fiji
  PG: { lat: -6.3, lng: 143.9 },    // Papua New Guinea
  NC: { lat: -20.9, lng: 165.6 },   // New Caledonia
  SB: { lat: -9.4, lng: 160.0 },    // Solomon Islands
  VU: { lat: -15.4, lng: 166.9 },   // Vanuatu
  WS: { lat: -13.8, lng: -172.0 },  // Samoa
  TO: { lat: -21.2, lng: -175.2 },  // Tonga
  PF: { lat: -17.7, lng: -149.4 },  // French Polynesia
  GU: { lat: 13.4, lng: 144.8 },    // Guam
  PW: { lat: 7.5, lng: 134.6 },     // Palau
  FM: { lat: 7.4, lng: 150.6 },     // Micronesia
  MH: { lat: 7.1, lng: 171.2 },     // Marshall Islands
  KI: { lat: -3.4, lng: -168.7 },   // Kiribati
  NR: { lat: -0.5, lng: 166.9 },    // Nauru
  TV: { lat: -7.1, lng: 177.6 },    // Tuvalu
  CK: { lat: -21.2, lng: -159.8 },  // Cook Islands

  // ═══════════════════════════════════════════════════════════════════════════
  // NORTH AFRICA
  // ═══════════════════════════════════════════════════════════════════════════
  EG: { lat: 26.8, lng: 30.8 },     // Egypt
  LY: { lat: 26.3, lng: 17.2 },     // Libya
  TN: { lat: 34.0, lng: 9.5 },      // Tunisia
  DZ: { lat: 28.0, lng: 1.7 },      // Algeria
  MA: { lat: 31.8, lng: -7.1 },     // Morocco
  SD: { lat: 12.9, lng: 30.2 },     // Sudan
  SS: { lat: 6.9, lng: 31.3 },      // South Sudan

  // ═══════════════════════════════════════════════════════════════════════════
  // WEST AFRICA
  // ═══════════════════════════════════════════════════════════════════════════
  NG: { lat: 9.1, lng: 8.7 },       // Nigeria
  GH: { lat: 7.9, lng: -1.0 },      // Ghana
  CI: { lat: 7.5, lng: -5.5 },      // Ivory Coast
  SN: { lat: 14.5, lng: -14.4 },    // Senegal
  ML: { lat: 17.6, lng: -4.0 },     // Mali
  BF: { lat: 12.2, lng: -1.6 },     // Burkina Faso
  NE: { lat: 17.6, lng: 8.1 },      // Niger
  MR: { lat: 21.0, lng: -10.9 },    // Mauritania
  GM: { lat: 13.4, lng: -15.3 },    // Gambia
  GN: { lat: 9.9, lng: -9.7 },      // Guinea
  GW: { lat: 11.8, lng: -15.2 },    // Guinea-Bissau
  SL: { lat: 8.5, lng: -11.8 },     // Sierra Leone
  LR: { lat: 6.4, lng: -9.4 },      // Liberia
  TG: { lat: 8.6, lng: 0.8 },       // Togo
  BJ: { lat: 9.3, lng: 2.3 },       // Benin
  CV: { lat: 16.0, lng: -24.0 },    // Cape Verde

  // ═══════════════════════════════════════════════════════════════════════════
  // CENTRAL AFRICA
  // ═══════════════════════════════════════════════════════════════════════════
  CD: { lat: -4.0, lng: 21.8 },     // Democratic Republic of the Congo
  CG: { lat: -0.2, lng: 15.8 },     // Republic of the Congo
  CM: { lat: 7.4, lng: 12.4 },      // Cameroon
  CF: { lat: 6.6, lng: 20.9 },      // Central African Republic
  TD: { lat: 15.5, lng: 18.7 },     // Chad
  GA: { lat: -0.8, lng: 11.6 },     // Gabon
  GQ: { lat: 1.6, lng: 10.3 },      // Equatorial Guinea
  ST: { lat: 0.2, lng: 6.6 },       // São Tomé and Príncipe
  AO: { lat: -11.2, lng: 17.9 },    // Angola

  // ═══════════════════════════════════════════════════════════════════════════
  // EAST AFRICA
  // ═══════════════════════════════════════════════════════════════════════════
  KE: { lat: -0.0, lng: 37.9 },     // Kenya
  ET: { lat: 9.1, lng: 40.5 },      // Ethiopia
  TZ: { lat: -6.4, lng: 34.9 },     // Tanzania
  UG: { lat: 1.4, lng: 32.3 },      // Uganda
  RW: { lat: -1.9, lng: 29.9 },     // Rwanda
  BI: { lat: -3.4, lng: 29.9 },     // Burundi
  SO: { lat: 5.2, lng: 46.2 },      // Somalia
  DJ: { lat: 11.6, lng: 42.6 },     // Djibouti
  ER: { lat: 15.2, lng: 39.8 },     // Eritrea
  MW: { lat: -13.3, lng: 34.3 },    // Malawi
  MZ: { lat: -18.7, lng: 35.5 },    // Mozambique
  MG: { lat: -18.8, lng: 46.9 },    // Madagascar
  MU: { lat: -20.3, lng: 57.6 },    // Mauritius
  SC: { lat: -4.7, lng: 55.5 },     // Seychelles
  KM: { lat: -11.6, lng: 43.3 },    // Comoros
  RE: { lat: -21.1, lng: 55.5 },    // Réunion

  // ═══════════════════════════════════════════════════════════════════════════
  // SOUTHERN AFRICA
  // ═══════════════════════════════════════════════════════════════════════════
  ZA: { lat: -30.6, lng: 22.9 },    // South Africa
  NA: { lat: -22.0, lng: 17.1 },    // Namibia
  BW: { lat: -22.3, lng: 24.7 },    // Botswana
  ZW: { lat: -19.0, lng: 29.2 },    // Zimbabwe
  ZM: { lat: -13.1, lng: 27.8 },    // Zambia
  SZ: { lat: -26.5, lng: 31.5 },    // Eswatini (Swaziland)
  LS: { lat: -29.6, lng: 28.2 },    // Lesotho
};

/**
 * A flag overlay representing streamer ownership of a country on the globe.
 */
export interface FlagOverlay {
  /** ISO 3166-1 alpha-2 country code (e.g., 'US', 'JP'). */
  countryCode: string;
  /** Unique identifier of the streamer who owns this flag. */
  ownerStreamerId: string;
  /** Display name of the owning streamer. */
  ownerDisplayName: string;
  /** Drawing progress from 0 (invisible) to 100 (fully drawn). */
  progress: number;
  /** Brand color of the owning streamer (hex or CSS color). */
  color: string;
}

/**
 * Polygon feature for globe.gl's polygonsData().
 * Represents a simple circular region around a country center.
 */
export interface FlagPolygon {
  /** GeoJSON-like coordinates for the polygon ring. */
  geometry: { type: 'Polygon'; coordinates: [number, number][][] };
  /** Properties for rendering. */
  properties: {
    countryCode: string;
    ownerStreamerId: string;
    ownerDisplayName: string;
    color: string;
    opacity: number;
  };
}

// Polygon radius in degrees (roughly 300-400km depending on latitude).
const FLAG_RADIUS_DEG = 3.5;
const POLYGON_SEGMENTS = 24;

/**
 * Creates a circular polygon ring around a center point.
 * Returns coordinates in [lng, lat] order for GeoJSON compatibility.
 */
function circlePolygon(centerLat: number, centerLng: number, radiusDeg: number): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= POLYGON_SEGMENTS; i++) {
    const angle = (i / POLYGON_SEGMENTS) * 2 * Math.PI;
    const lat = centerLat + radiusDeg * Math.sin(angle);
    // Adjust longitude by latitude to keep circles round-ish on the globe.
    const lngScale = 1 / Math.cos((centerLat * Math.PI) / 180);
    const lng = centerLng + radiusDeg * Math.cos(angle) * Math.min(lngScale, 3);
    ring.push([lng, lat]);
  }
  return ring;
}

/**
 * Converts FlagOverlay data into polygon data for globe.gl's polygonsData().
 * Each flag becomes a circular polygon over its country with opacity based on progress.
 *
 * Usage with globe.gl:
 * ```ts
 * globe
 *   .polygonsData(flagPolygonData(flags))
 *   .polygonCapColor((d) => d.properties.color)
 *   .polygonSideColor(() => 'rgba(0, 0, 0, 0.1)')
 *   .polygonStrokeColor(() => '#fff')
 *   .polygonAltitude(0.01)
 *   .polygonCapMaterial((d) => new MeshBasicMaterial({ color: d.properties.color, opacity: d.properties.opacity, transparent: true }))
 * ```
 */
export function flagPolygonData(flags: FlagOverlay[]): FlagPolygon[] {
  return flags
    .filter((flag) => flag.countryCode in COUNTRY_CENTERS && flag.progress > 0)
    .map((flag): FlagPolygon => {
      const center = COUNTRY_CENTERS[flag.countryCode];
      if (!center) throw new Error(`No center for ${flag.countryCode}`);
      const ring = circlePolygon(center.lat, center.lng, FLAG_RADIUS_DEG);
      return {
        geometry: {
          type: 'Polygon',
          coordinates: [ring],
        },
        properties: {
          countryCode: flag.countryCode,
          ownerStreamerId: flag.ownerStreamerId,
          ownerDisplayName: flag.ownerDisplayName,
          color: flag.color,
          // Map progress 0-100 to opacity 0-0.7 (never fully opaque to see globe underneath).
          opacity: Math.min(0.7, (flag.progress / 100) * 0.7),
        },
      };
    });
}

/**
 * Converts an ISO 3166-1 alpha-2 country code to its flag emoji.
 * Uses Unicode regional indicator symbols.
 *
 * @example
 * getFlagEmoji('US') // → '🇺🇸'
 * getFlagEmoji('JP') // → '🇯🇵'
 * getFlagEmoji('BR') // → '🇧🇷'
 */
export function getFlagEmoji(countryCode: string): string {
  if (countryCode.length !== 2) return '🏳️';

  const code = countryCode.toUpperCase();

  // Regional indicator symbols start at U+1F1E6 for 'A'.
  // Each letter A-Z maps to U+1F1E6 to U+1F1FF.
  const REGIONAL_A = 0x1f1e6;
  const CHAR_A = 65; // 'A'.charCodeAt(0)

  const first = code.charCodeAt(0);
  const second = code.charCodeAt(1);

  // Validate A-Z range.
  if (first < 65 || first > 90 || second < 65 || second > 90) return '🏳️';

  const firstIndicator = REGIONAL_A + (first - CHAR_A);
  const secondIndicator = REGIONAL_A + (second - CHAR_A);

  return String.fromCodePoint(firstIndicator, secondIndicator);
}

/**
 * Gets the country code for a given coordinate, finding the nearest country center.
 * Useful for approximate reverse geocoding on the globe.
 *
 * @returns The ISO 3166-1 alpha-2 code of the nearest country, or null if too far from any.
 */
export function nearestCountryCode(lat: number, lng: number, maxDistanceDeg = 15): string | null {
  let nearest: string | null = null;
  let minDist = Infinity;

  for (const [code, center] of Object.entries(COUNTRY_CENTERS)) {
    // Simple Euclidean distance in degrees (good enough for this purpose).
    const dLat = lat - center.lat;
    // Account for longitude wrapping.
    let dLng = lng - center.lng;
    if (dLng > 180) dLng -= 360;
    if (dLng < -180) dLng += 360;

    const dist = Math.sqrt(dLat * dLat + dLng * dLng);
    if (dist < minDist) {
      minDist = dist;
      nearest = code;
    }
  }

  return minDist <= maxDistanceDeg ? nearest : null;
}

/**
 * Returns all country codes as an array.
 */
export function getAllCountryCodes(): string[] {
  return Object.keys(COUNTRY_CENTERS);
}

/**
 * Checks if a country code is valid (exists in COUNTRY_CENTERS).
 */
export function isValidCountryCode(code: string): boolean {
  return code in COUNTRY_CENTERS;
}
