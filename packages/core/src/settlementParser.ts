import { add, cents, parse, type Cents } from './money';

export const MAX_SETTLEMENT_FILE_BYTES = 1024 * 1024;
export const MAX_SETTLEMENT_ROWS = 1000;
export const SETTLEMENT_COLUMNS = [
  'tracking_number',
  'cod_collected',
  'delivery_fee',
  'return_fee',
  'net_amount',
  'courier_status',
] as const;
export type SettlementColumn = (typeof SETTLEMENT_COLUMNS)[number];

export type SettlementRow = {
  line: number;
  trackingNumber: string;
  codCollectedCentimes: Cents;
  deliveryFeeCentimes: Cents;
  returnFeeCentimes: Cents;
  netCentimes: Cents;
  rawCourierStatus: string;
};
export type SettlementRowError = {
  line: number;
  column: SettlementColumn | 'row';
  code: 'invalid_money' | 'invalid_text' | 'column_count';
  message: string;
};
export type SettlementPreview = {
  valid: boolean;
  rowCount: number;
  invalidRowCount: number;
  rows: SettlementRow[];
  errors: SettlementRowError[];
  totals: {
    codCollectedCentimes: Cents;
    deliveryFeeCentimes: Cents;
    returnFeeCentimes: Cents;
    netCentimes: Cents;
  };
};
export class SettlementParseError extends Error {
  constructor(
    readonly code:
      | 'file_too_large'
      | 'too_many_rows'
      | 'empty_file'
      | 'invalid_csv'
      | 'missing_columns'
      | 'duplicate_columns'
      | 'totals_overflow',
    message: string,
  ) {
    super(message);
    this.name = 'SettlementParseError';
  }
}

const aliases: Readonly<Record<string, SettlementColumn>> = {
  tracking_number: 'tracking_number',
  numero_suivi: 'tracking_number',
  cod_collected: 'cod_collected',
  montant_encaisse: 'cod_collected',
  delivery_fee: 'delivery_fee',
  frais_livraison: 'delivery_fee',
  return_fee: 'return_fee',
  frais_retour: 'return_fee',
  net_amount: 'net_amount',
  montant_net: 'net_amount',
  courier_status: 'courier_status',
  statut: 'courier_status',
};
const labels: Record<SettlementColumn, string> = {
  tracking_number: 'Numéro de suivi',
  cod_collected: 'Montant encaissé',
  delivery_fee: 'Frais de livraison',
  return_fee: 'Frais de retour',
  net_amount: 'Montant net',
  courier_status: 'Statut transporteur',
};

/** Pure preview: no database, network, clock or order-state changes. Amount columns contain MAD. */
export function parseSettlementCsv(input: string): SettlementPreview {
  let bytes = 0;
  for (const character of input) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > MAX_SETTLEMENT_FILE_BYTES) {
      throw new SettlementParseError('file_too_large', 'Le fichier dépasse la limite de 1 Mio.');
    }
  }
  const source = input.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const records = readCsv(source, chooseDelimiter(source));
  const header = records.shift();
  if (header === undefined) throw new SettlementParseError('empty_file', 'Le fichier est vide.');
  const normalizedHeaders = header.cells.map(normalizeHeader);
  const canonicalHeaders = normalizedHeaders.map((name) =>
    Object.hasOwn(aliases, name) ? aliases[name]! : name,
  );
  if (new Set(canonicalHeaders).size !== canonicalHeaders.length) {
    throw new SettlementParseError(
      'duplicate_columns',
      'Le fichier contient des colonnes en double.',
    );
  }
  const missing = SETTLEMENT_COLUMNS.filter((column) => !canonicalHeaders.includes(column));
  if (missing.length > 0) {
    throw new SettlementParseError(
      'missing_columns',
      `Colonnes manquantes : ${missing.map((column) => labels[column]).join(', ')}.`,
    );
  }
  if (records.length === 0)
    throw new SettlementParseError('empty_file', 'Le fichier ne contient aucune ligne de colis.');
  const indexes = Object.fromEntries(
    SETTLEMENT_COLUMNS.map((column) => [column, canonicalHeaders.indexOf(column)]),
  ) as Record<SettlementColumn, number>;
  const preview: SettlementPreview = {
    valid: true,
    rowCount: records.length,
    invalidRowCount: 0,
    rows: [],
    errors: [],
    totals: {
      codCollectedCentimes: cents(0),
      deliveryFeeCentimes: cents(0),
      returnFeeCentimes: cents(0),
      netCentimes: cents(0),
    },
  };
  for (const record of records) {
    const previousErrors = preview.errors.length;
    const error = (
      column: SettlementRowError['column'],
      code: SettlementRowError['code'],
      message: string,
    ) => preview.errors.push({ line: record.line, column, code, message });
    if (record.cells.length !== header.cells.length) {
      error('row', 'column_count', 'Le nombre de valeurs ne correspond pas aux colonnes.');
    }
    const text = (column: SettlementColumn, maxLength: number) => {
      const value = (record.cells[indexes[column]] ?? '').trim();
      if (
        !value ||
        value.length > maxLength ||
        [...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      ) {
        error(
          column,
          'invalid_text',
          `${labels[column]} : valeur obligatoire, sans caractères de contrôle (${maxLength} caractères maximum).`,
        );
      }
      return value;
    };
    const money = (column: SettlementColumn): Cents => {
      const value = (record.cells[indexes[column]] ?? '').trim();
      try {
        // No currency suffix, grouping, exponent, signs or rounding of extra decimals.
        if (value.length > 18 || !/^\d+(?:[.,]\d{1,2})?$/u.test(value))
          throw new Error('Invalid amount');
        return parse(value);
      } catch {
        error(
          column,
          'invalid_money',
          `${labels[column]} : montant MAD positif ou nul, avec deux décimales maximum.`,
        );
        return cents(0);
      }
    };
    const row: SettlementRow = {
      line: record.line,
      trackingNumber: text('tracking_number', 128),
      rawCourierStatus: text('courier_status', 120),
      codCollectedCentimes: money('cod_collected'),
      deliveryFeeCentimes: money('delivery_fee'),
      returnFeeCentimes: money('return_fee'),
      netCentimes: money('net_amount'),
    };
    if (preview.errors.length > previousErrors) {
      preview.invalidRowCount += 1;
      continue;
    }
    preview.rows.push(row);
    try {
      preview.totals.codCollectedCentimes = add(
        preview.totals.codCollectedCentimes,
        row.codCollectedCentimes,
      );
      preview.totals.deliveryFeeCentimes = add(
        preview.totals.deliveryFeeCentimes,
        row.deliveryFeeCentimes,
      );
      preview.totals.returnFeeCentimes = add(
        preview.totals.returnFeeCentimes,
        row.returnFeeCentimes,
      );
      preview.totals.netCentimes = add(preview.totals.netCentimes, row.netCentimes);
    } catch {
      throw new SettlementParseError(
        'totals_overflow',
        'Les totaux dépassent la plage de montants autorisée.',
      );
    }
  }
  preview.valid = preview.errors.length === 0;
  return preview;
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
}
function chooseDelimiter(source: string): ',' | ';' {
  let quoted = false;
  let commas = 0;
  let semicolons = 0;
  for (const character of source) {
    if (character === '"') quoted = !quoted;
    if (!quoted && character === '\n' && (commas > 0 || semicolons > 0)) break;
    if (!quoted && character === ',') commas += 1;
    if (!quoted && character === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

function readCsv(source: string, delimiter: string): { line: number; cells: string[] }[] {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let field = '';
  let state: 'plain' | 'quoted' | 'closed' = 'plain';
  let line = 1;
  let recordLine = 1;
  const finishRecord = () => {
    cells.push(field);
    if (cells.length > 1 || cells.some((cell) => cell.trim() !== ''))
      records.push({ line: recordLine, cells });
    if (records.length > MAX_SETTLEMENT_ROWS + 1) {
      throw new SettlementParseError(
        'too_many_rows',
        'Le fichier dépasse la limite de 1 000 lignes.',
      );
    }
    cells = [];
    field = '';
    state = 'plain';
    recordLine = line + 1;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (state === 'quoted') {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else state = 'closed';
      } else {
        field += character;
        if (character === '\n') line += 1;
      }
      continue;
    }
    if (character === delimiter) {
      cells.push(field);
      field = '';
      state = 'plain';
    } else if (character === '\n') {
      finishRecord();
      line += 1;
    } else if (character === '"' && state === 'plain' && field === '') state = 'quoted';
    else if (character === '"' || state === 'closed') {
      throw new SettlementParseError('invalid_csv', `CSV mal formé à la ligne ${line}.`);
    } else field += character;
  }
  if (state === 'quoted')
    throw new SettlementParseError(
      'invalid_csv',
      'Une valeur entre guillemets n’est pas terminée.',
    );
  if (cells.length > 0 || field !== '' || state === 'closed') finishRecord();
  return records;
}
