import { describe, expect, it } from 'vitest';
import { coarseCountryPoint } from '../src/location.js';

describe('country-level location privacy', () => {
  it('coarsens browser coordinates before they reach the globe', () => {
    expect(coarseCountryPoint({ latitude: 19.432608, longitude: -99.133209 }))
      .toEqual({ lat: 19, lng: -99 });
  });

  it('bounds malformed browser coordinates to globe limits', () => {
    expect(coarseCountryPoint({ latitude: 120, longitude: -240 }))
      .toEqual({ lat: 90, lng: -180 });
  });
});
