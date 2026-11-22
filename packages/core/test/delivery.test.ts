import { describe, expect, it } from 'vitest';
import { resolveDeliveryZone, UnsupportedDeliveryZoneError } from '../src/delivery';

describe('customer delivery policy', () => {
  it.each([
    ['Rabat', 2000],
    [' Salé ', 2000],
    ['SALE', 2000],
    ['Témara', 2500],
    ['temara', 2500],
  ] as const)('prices %s in centimes', (city, fee) =>
    expect(resolveDeliveryZone(city).feeCentimes).toBe(fee),
  );
  it.each(['', 'Casablanca', 'Rabat Agdal', 'Sale Al Jadida', 'Skhirat'])(
    'does not silently include unspecified areas: %s',
    (city) => expect(() => resolveDeliveryZone(city)).toThrow(UnsupportedDeliveryZoneError),
  );
});
