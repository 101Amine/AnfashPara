// Customer delivery charges, independent of the courier's actual costs.
export const DELIVERY_POLICY_VERSION = '2026-11-22';
export const DELIVERY_ZONES = [
  { id: 'rabat', city: 'Rabat', feeCentimes: 2000 },
  { id: 'sale', city: 'Salé', feeCentimes: 2000 },
  { id: 'temara', city: 'Témara', feeCentimes: 2500 },
] as const;

export class UnsupportedDeliveryZoneError extends Error {
  constructor() {
    super('La livraison est disponible uniquement à Rabat, Salé et Témara.');
    this.name = 'UnsupportedDeliveryZoneError';
  }
}

export function resolveDeliveryZone(city: string) {
  const id = city.trim().normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase();
  const zone = DELIVERY_ZONES.find((candidate) => candidate.id === id);
  if (!zone) throw new UnsupportedDeliveryZoneError();
  return zone;
}
