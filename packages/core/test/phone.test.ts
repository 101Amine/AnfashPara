import { describe, expect, it } from 'vitest';

import { normalizeMoroccanMobile, toWaMeUrl } from '../src/phone';

describe('normalizeMoroccanMobile', () => {
  it.each([
    ['0612345678', '+212612345678'],
    ['0712345678', '+212712345678'],
    ['06 12 34 56 78', '+212612345678'],
    ['  07 12 34 56 78  ', '+212712345678'],
    ['+212612345678', '+212612345678'],
    ['+212 6 12 34 56 78', '+212612345678'],
    ['00212612345678', '+212612345678'],
    ['00 212 7 12 34 56 78', '+212712345678'],
    ['06\u00a012\u00a034\u00a056\u00a078', '+212612345678'],
  ])('normalizes %j to %s', (input, expected) => {
    expect(normalizeMoroccanMobile(input)).toBe(expected);
  });

  it.each([
    '0512345678',
    '+212512345678',
    '00212512345678',
    '+33612345678',
    '0033612345678',
    '0812345678',
    '612345678',
    '212612345678',
    '+2120612345678',
    '002120612345678',
    '061234567',
    '06123456789',
    '+21261234567',
    '+2126123456789',
    '06-12-34-56-78',
    '(+212)612345678',
    '06123abc78',
    '',
    '   ',
    '++212612345678',
    '+00212612345678',
  ])('rejects unsupported or malformed input %j', (input) => {
    expect(() => normalizeMoroccanMobile(input)).toThrow(SyntaxError);
  });
});

describe('toWaMeUrl', () => {
  it('builds a WhatsApp URL from a national number', () => {
    expect(toWaMeUrl('06 12 34 56 78')).toBe('https://wa.me/212612345678');
  });

  it('builds the same URL from an E.164 number', () => {
    expect(toWaMeUrl('+212612345678')).toBe('https://wa.me/212612345678');
  });

  it('rejects invalid phone numbers instead of creating broken URLs', () => {
    expect(() => toWaMeUrl('0512345678')).toThrow(SyntaxError);
  });
});
