import { describe, expect, it } from 'vitest';

import { add, cents, format, mul, parse, pct, sub } from '../src/money';

describe('cents', () => {
  it('creates zero cents', () => {
    expect(cents(0)).toBe(0);
  });

  it('creates positive cents', () => {
    expect(cents(125)).toBe(125);
  });

  it('creates negative cents', () => {
    expect(cents(-125)).toBe(-125);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid centime value %s',
    (value) => {
      expect(() => cents(value)).toThrow(RangeError);
    },
  );
});

describe('add', () => {
  it('adds two amounts', () => {
    expect(add(cents(125), cents(75))).toBe(200);
  });

  it('adds negative amounts', () => {
    expect(add(cents(125), cents(-200))).toBe(-75);
  });

  it('rejects an unsafe result', () => {
    expect(() => add(cents(Number.MAX_SAFE_INTEGER), cents(1))).toThrow(RangeError);
  });
});

describe('sub', () => {
  it('subtracts two amounts', () => {
    expect(sub(cents(200), cents(75))).toBe(125);
  });

  it('can produce a negative result', () => {
    expect(sub(cents(75), cents(200))).toBe(-125);
  });

  it('rejects an unsafe result', () => {
    expect(() => sub(cents(Number.MIN_SAFE_INTEGER), cents(1))).toThrow(RangeError);
  });
});

describe('mul', () => {
  it('multiplies by an integer', () => {
    expect(mul(cents(125), 3)).toBe(375);
  });

  it('multiplies by a decimal', () => {
    expect(mul(cents(100), 1.25)).toBe(125);
  });

  it('rounds positive halves away from zero', () => {
    expect(mul(cents(5), 0.5)).toBe(3);
  });

  it('rounds negative halves away from zero', () => {
    expect(mul(cents(-5), 0.5)).toBe(-3);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid multiplier %s', (value) => {
    expect(() => mul(cents(100), value)).toThrow(RangeError);
  });

  it('rejects an unsafe result', () => {
    expect(() => mul(cents(Number.MAX_SAFE_INTEGER), 2)).toThrow(RangeError);
  });
});

describe('pct', () => {
  it('calculates a whole percentage', () => {
    expect(pct(cents(10_000), 20)).toBe(2_000);
  });

  it('rounds a fractional positive result', () => {
    expect(pct(cents(50), 5)).toBe(3);
  });

  it('rounds a fractional negative result symmetrically', () => {
    expect(pct(cents(-50), 5)).toBe(-3);
  });

  it('supports negative percentages', () => {
    expect(pct(cents(1_000), -10)).toBe(-100);
  });
});

describe('format', () => {
  it('formats positive centimes as currency units', () => {
    expect(format(cents(1_234), { currency: 'USD', locale: 'en-US' })).toBe('$12.34');
  });

  it('formats negative centimes', () => {
    expect(format(cents(-505), { currency: 'USD', locale: 'en-US' })).toBe('-$5.05');
  });

  it('uses MAD as the default currency', () => {
    expect(format(cents(1_234), { locale: 'en-US' })).toContain('MAD');
  });
});

describe('parse', () => {
  it.each([
    ['12', 1_200],
    ['12.3', 1_230],
    ['12.30', 1_230],
    ['12,30', 1_230],
    ['-0.05', -5],
    ['+7.01', 701],
    ['  4.20  ', 420],
  ])('parses %j into %i cents', (input, expected) => {
    expect(parse(input)).toBe(expected);
  });

  it.each(['', '12.345', '1e3', '12abc', '.50', '1,000.00', 'MAD 12.00'])(
    'rejects malformed input %j',
    (input) => {
      expect(() => parse(input)).toThrow(SyntaxError);
    },
  );

  it('rejects values outside the safe integer range', () => {
    expect(() => parse('90071992547410.00')).toThrow(RangeError);
  });
});
