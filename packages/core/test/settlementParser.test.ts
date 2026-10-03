import { describe, expect, it } from 'vitest';
import validCsv from './fixtures/settlements/valid.csv?raw';
import frenchCsv from './fixtures/settlements/french.csv?raw';
import invalidCsv from './fixtures/settlements/invalid.csv?raw';

import {
  MAX_SETTLEMENT_FILE_BYTES,
  MAX_SETTLEMENT_ROWS,
  parseSettlementCsv,
  SETTLEMENT_COLUMNS,
  SettlementParseError,
} from '../src/settlementParser';

const header = SETTLEMENT_COLUMNS.join(',');
const row = 'SELF-TEST,100,30,0,70,delivered';
const csv = (value = row) => `${header}\n${value}`;
const fixture = (name: 'valid' | 'french' | 'invalid') =>
  ({ valid: validCsv, french: frenchCsv, invalid: invalidCsv })[name];

describe('pure settlement CSV preview', () => {
  it('normalizes the fictional fixture and calculates exact centime totals', () => {
    const preview = parseSettlementCsv(fixture('valid'));
    expect(preview.valid).toBe(true);
    expect(preview.rowCount).toBe(3);
    expect(preview.rows[0]).toEqual({
      line: 2,
      trackingNumber: 'SELF-DEMO-001',
      rawCourierStatus: 'delivered',
      codCollectedCentimes: 25000,
      deliveryFeeCentimes: 3000,
      returnFeeCentimes: 0,
      netCentimes: 22000,
    });
    expect(preview.totals).toEqual({
      codCollectedCentimes: 34990,
      deliveryFeeCentimes: 5500,
      returnFeeCentimes: 2000,
      netCentimes: 29490,
    });
  });

  it('accepts a BOM, CRLF, French columns, semicolons and decimal commas', () => {
    const preview = parseSettlementCsv('\uFEFF' + fixture('french').replaceAll('\n', '\r\n'));
    expect(preview.valid).toBe(true);
    expect(preview.rows[0]?.rawCourierStatus).toBe('Livré');
    expect(preview.totals.codCollectedCentimes).toBe(25000);
    expect(preview.totals.returnFeeCentimes).toBe(2000);
  });

  it('supports reordered headers, ignored extra columns, quoted delimiters and escaped quotes', () => {
    const preview = parseSettlementCsv(
      'courier_status,net_amount,return_fee,delivery_fee,cod_collected,tracking_number,note\n"Livré, signé",70,0,30,100,"SELF-""TEST""","ignored\ntext"',
    );
    expect(preview.valid).toBe(true);
    expect(preview.rows[0]?.trackingNumber).toBe('SELF-"TEST"');
    expect(preview.rows[0]?.rawCourierStatus).toBe('Livré, signé');
  });

  it('reports physical line numbers after blank lines and multiline quoted fields', () => {
    const preview = parseSettlementCsv(
      `\n${header},note\n${row},"first\nsecond"\n\n,1,0,0,1,delivered,x`,
    );
    expect(preview.errors[0]?.line).toBe(6);
    expect(preview.rows[0]?.line).toBe(3);
  });

  it('reports row-level French errors and excludes invalid rows from totals', () => {
    const preview = parseSettlementCsv(fixture('invalid') + row);
    expect(preview.valid).toBe(false);
    expect(preview.invalidRowCount).toBe(2);
    expect(preview.rows).toHaveLength(1);
    expect(preview.totals.netCentimes).toBe(7000);
    expect(preview.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 2, column: 'tracking_number', code: 'invalid_text' }),
        expect.objectContaining({ line: 2, column: 'cod_collected', code: 'invalid_money' }),
        expect.objectContaining({ line: 3, column: 'delivery_fee', code: 'invalid_money' }),
        expect.objectContaining({ line: 3, column: 'courier_status', code: 'invalid_text' }),
      ]),
    );
  });

  it.each([
    '',
    '1.001',
    '1e2',
    '-1',
    '+1',
    '1 000',
    '1,000.00',
    'NaN',
    'Infinity',
    '5 MAD',
    '90071992547410',
  ])('rejects malformed or unsafe money %j without rounding', (value) => {
    const preview = parseSettlementCsv(csv(`SELF-TEST,${JSON.stringify(value)},30,0,70,delivered`));
    expect(preview.errors).toContainEqual(
      expect.objectContaining({ column: 'cod_collected', code: 'invalid_money' }),
    );
    expect(preview.rows).toHaveLength(0);
  });

  it('adds decimal amounts exactly and accepts integer and single decimal MAD', () => {
    const preview = parseSettlementCsv(csv('A,0.1,0,0,0.1,delivered\nB,0.20,0,0,0.20,delivered'));
    expect(preview.totals.netCentimes).toBe(30);
  });

  it.each(['', '\n \n', header])('rejects an empty statement %j', (source) => {
    expect(() => parseSettlementCsv(source)).toThrow(SettlementParseError);
  });

  it('rejects missing headers and duplicate names including aliases', () => {
    expect(() => parseSettlementCsv('tracking_number,net_amount\nA,10')).toThrow(
      'Colonnes manquantes',
    );
    expect(() => parseSettlementCsv(`${header},tracking_number\n${row},B`)).toThrow(
      'colonnes en double',
    );
    expect(() => parseSettlementCsv(`${header},Numéro suivi\n${row},B`)).toThrow(
      'colonnes en double',
    );
  });

  it.each(['"unterminated', 'A"B,100,30,0,70,delivered', '"A"x,100,30,0,70,delivered'])(
    'rejects malformed CSV %j',
    (value) => expect(() => parseSettlementCsv(csv(value))).toThrow(SettlementParseError),
  );

  it('reports missing and extra cell counts', () => {
    expect(parseSettlementCsv(csv(row + ',extra')).errors[0]?.code).toBe('column_count');
    expect(parseSettlementCsv(csv('A,100')).errors[0]?.code).toBe('column_count');
  });

  it('enforces UTF-8 file limits, including multibyte input', () => {
    expect(() => parseSettlementCsv('a'.repeat(MAX_SETTLEMENT_FILE_BYTES + 1))).toThrow('1 Mio');
    expect(() => parseSettlementCsv('é'.repeat(MAX_SETTLEMENT_FILE_BYTES / 2 + 1))).toThrow(
      '1 Mio',
    );
  });

  it('accepts a file exactly at the byte limit', () => {
    const base = `${header},note\n${row},`;
    expect(
      parseSettlementCsv(base + 'x'.repeat(MAX_SETTLEMENT_FILE_BYTES - base.length)).valid,
    ).toBe(true);
  });

  it('rejects rows of empty values and controls in required text', () => {
    expect(parseSettlementCsv(csv(',,,,,')).invalidRowCount).toBe(1);
    expect(parseSettlementCsv(csv('"TRACK\nINJECTED",100,30,0,70,delivered')).errors[0]?.code).toBe(
      'invalid_text',
    );
  });

  it('accepts 1000 rows and rejects 1001 rows', () => {
    expect(
      parseSettlementCsv(csv(Array(MAX_SETTLEMENT_ROWS).fill(row).join('\n'))).rows,
    ).toHaveLength(1000);
    expect(() =>
      parseSettlementCsv(
        csv(
          Array(MAX_SETTLEMENT_ROWS + 1)
            .fill(row)
            .join('\n'),
        ),
      ),
    ).toThrow('1 000 lignes');
  });

  it('rejects aggregate overflow even when individual amounts are safe', () => {
    const huge = 'A,90071992547409.91,0,0,0,delivered';
    expect(() => parseSettlementCsv(csv(`${huge}\n${huge}`))).toThrow('totaux');
  });

  it('preserves unknown raw statuses without making an order transition or a reconciliation decision', () => {
    expect(
      parseSettlementCsv(csv('A,100,30,0,999,UNKNOWN_COURIER_STATE')).rows[0]?.rawCourierStatus,
    ).toBe('UNKNOWN_COURIER_STATE');
  });
});
