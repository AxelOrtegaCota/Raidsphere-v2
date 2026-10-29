export interface BrowserCoordinates {
  latitude: number;
  longitude: number;
}

export interface CountryPoint {
  lat: number;
  lng: number;
}

// Coarsen immediately to roughly country-scale precision. The precise browser
// coordinates are not retained, logged, or sent to the RaidSphere server.
export function coarseCountryPoint(coordinates: BrowserCoordinates): CountryPoint {
  return {
    lat: Math.round(Math.max(-90, Math.min(90, coordinates.latitude))),
    lng: Math.round(Math.max(-180, Math.min(180, coordinates.longitude))),
  };
}
