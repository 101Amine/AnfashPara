declare const centsBrand: unique symbol;

export type Cents = number & { readonly [centsBrand]: 'Cents' };

export interface CurrencyFormatOptions {
  readonly currency?: string;
  readonly locale?: string | readonly string[];
}

const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_CENTS = BigInt(Number.MIN_SAFE_INTEGER);

export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('A centime amount must be a safe integer.');
  }

  return value as Cents;
}

export function add(left: Cents, right: Cents): Cents {
  return centsFromBigInt(BigInt(cents(left)) + BigInt(cents(right)));
}

export function sub(left: Cents, right: Cents): Cents {
  return centsFromBigInt(BigInt(cents(left)) - BigInt(cents(right)));
}

export function mul(amount: Cents, multiplier: number): Cents {
  cents(amount);

  if (!Number.isFinite(multiplier)) {
    throw new RangeError('A money multiplier must be finite.');
  }

  return roundHalfAwayFromZero(amount * multiplier);
}

export function pct(amount: Cents, percentage: number): Cents {
  return mul(amount, percentage / 100);
}

export function format(amount: Cents, options: CurrencyFormatOptions = {}): string {
  cents(amount);

  const { currency = 'MAD', locale = 'fr-MA' } = options;
  const formatter = new Intl.NumberFormat(locale, {
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  });
  const absoluteAmount = BigInt(Math.abs(amount));
  const majorUnits = absoluteAmount / 100n;
  const minorUnits = String(absoluteAmount % 100n).padStart(2, '0');
  const signedMajorUnits: bigint | number =
    amount < 0 ? (majorUnits === 0n ? -0 : -majorUnits) : majorUnits;

  return formatter
    .formatToParts(signedMajorUnits)
    .map((part) => (part.type === 'fraction' ? minorUnits : part.value))
    .join('');
}

export function parse(input: string): Cents {
  const match = /^([+-]?)(\d+)(?:[.,](\d{1,2}))?$/.exec(input.trim());

  if (!match) {
    throw new SyntaxError('Expected a plain amount with at most two decimal places.');
  }

  const [, sign, majorDigits, minorDigits = ''] = match;

  if (majorDigits === undefined) {
    throw new SyntaxError('Expected digits before the decimal separator.');
  }

  const magnitude = BigInt(majorDigits) * 100n + BigInt(minorDigits.padEnd(2, '0') || '0');
  const signedAmount = sign === '-' ? -magnitude : magnitude;

  return centsFromBigInt(signedAmount);
}

function roundHalfAwayFromZero(value: number): Cents {
  if (!Number.isFinite(value)) {
    throw new RangeError('The calculated centime amount must be finite.');
  }

  const rounded = Math.sign(value) * Math.round(Math.abs(value));
  return cents(rounded);
}

function centsFromBigInt(value: bigint): Cents {
  if (value < MIN_SAFE_CENTS || value > MAX_SAFE_CENTS) {
    throw new RangeError('The calculated centime amount exceeds the safe integer range.');
  }

  return cents(Number(value));
}
