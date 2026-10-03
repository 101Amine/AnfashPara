// apps/api/src/modules/dashboard/dashboard.presenter.ts
export const DASHBOARD_TIMEZONE = 'Africa/Casablanca';
const localParts = (date: Date) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DASHBOARD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
};

// Resolve each local midnight independently: a Ramadan offset change can make a week 167/169h.
function midnightUtc(localMidnight: number): string {
  let candidate = localMidnight;
  for (let attempt = 0; attempt < 4; attempt++) {
    const correction = localMidnight - localParts(new Date(candidate));
    if (correction === 0) return new Date(candidate).toISOString();
    candidate += correction;
  }
  throw new RangeError('Unable to resolve Casablanca midnight');
}

export function dashboardWeek(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid dashboard date');
  const local = new Date(localParts(now));
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const monday = day - ((local.getUTCDay() + 6) % 7) * 86_400_000;
  return {
    timezone: DASHBOARD_TIMEZONE,
    start: midnightUtc(monday),
    end: midnightUtc(monday + 7 * 86_400_000),
    asOf: now.toISOString(),
  };
}

export function dashboardMoney(centimes: number): string {
  if (!Number.isSafeInteger(centimes)) throw new RangeError('Unsafe dashboard money');
  return new Intl.NumberFormat('fr-MA', { style: 'currency', currency: 'MAD' }).format(
    centimes / 100,
  );
}

export function refusalRate(refused: number, outcomes: number): string {
  return outcomes === 0
    ? '—'
    : new Intl.NumberFormat('fr-MA', {
        style: 'percent',
        maximumFractionDigits: 1,
      }).format(refused / outcomes);
}
