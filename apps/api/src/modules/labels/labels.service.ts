// apps/api/src/modules/labels/labels.service.ts
const STORE_ID = 'para-main';
const MAX_LABEL_BYTES = 5_000_000;

type ShipmentLabelRow = {
  label_url: string | null;
  order_number: string | null;
  shipment_id: string;
  tracking_number: string;
};

export type ShipmentLabel = {
  labelUrl: string;
  orderNumber: string | null;
  shipmentId: string;
  trackingNumber: string;
};

export type DownloadedLabel = {
  bytes: Uint8Array;
  contentType: 'application/pdf' | 'image/jpeg' | 'image/png';
  extension: 'jpg' | 'pdf' | 'png';
};

export type LabelFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ShipmentLabelNotFoundError extends Error {
  constructor() {
    super('Shipment not found');
    this.name = 'ShipmentLabelNotFoundError';
  }
}

export class ShipmentLabelMissingError extends Error {
  readonly references: string[];

  constructor(references: string[]) {
    super('One or more shipments do not have a label');
    this.name = 'ShipmentLabelMissingError';
    this.references = references;
  }
}

export class LabelConfigurationError extends Error {
  constructor() {
    super('Label origin is not allowed');
    this.name = 'LabelConfigurationError';
  }
}

export class LabelDownloadError extends Error {
  constructor() {
    super('Label could not be downloaded');
    this.name = 'LabelDownloadError';
  }
}

export async function getShipmentLabel(
  database: D1Database,
  shipmentId: string,
): Promise<ShipmentLabel> {
  const row = await database
    .prepare(
      `SELECT s.id AS shipment_id, s.tracking_number, s.label_url, o.order_number
       FROM shipments s
       INNER JOIN orders o ON o.id = s.order_id
       WHERE s.store_id = ? AND s.id = ?
       LIMIT 1`,
    )
    .bind(STORE_ID, shipmentId)
    .first<ShipmentLabelRow>();

  if (row === null) throw new ShipmentLabelNotFoundError();
  if (row.label_url === null || row.label_url.trim() === '') {
    throw new ShipmentLabelMissingError([row.order_number ?? row.tracking_number]);
  }
  return toShipmentLabel(row);
}

export async function getShipmentLabels(
  database: D1Database,
  shipmentIds: string[],
): Promise<ShipmentLabel[]> {
  const uniqueIds = [...new Set(shipmentIds)];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = await database
    .prepare(
      `SELECT s.id AS shipment_id, s.tracking_number, s.label_url, o.order_number
       FROM shipments s
       INNER JOIN orders o ON o.id = s.order_id
       WHERE s.store_id = ? AND s.id IN (${placeholders})`,
    )
    .bind(STORE_ID, ...uniqueIds)
    .all<ShipmentLabelRow>();

  const byId = new Map(rows.results.map((row) => [row.shipment_id, row]));
  const missingReferences: string[] = [];
  const labels: ShipmentLabel[] = [];
  for (const shipmentId of uniqueIds) {
    const row = byId.get(shipmentId);
    if (row === undefined) throw new ShipmentLabelNotFoundError();
    if (row.label_url === null || row.label_url.trim() === '') {
      missingReferences.push(row.order_number ?? row.tracking_number);
      continue;
    }
    labels.push(toShipmentLabel(row));
  }

  if (missingReferences.length > 0) throw new ShipmentLabelMissingError(missingReferences);
  return labels;
}

export function parseAllowedLabelOrigins(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.trim() === '') throw new LabelConfigurationError();

  const origins = new Set<string>();
  for (const entry of value.split(',')) {
    try {
      const url = new URL(entry.trim());
      if (url.protocol !== 'https:' || url.pathname !== '/') throw new LabelConfigurationError();
      origins.add(url.origin);
    } catch (error) {
      if (error instanceof LabelConfigurationError) throw error;
      throw new LabelConfigurationError();
    }
  }
  return origins;
}

export function assertAllowedLabelUrls(
  labels: ShipmentLabel[],
  allowedOrigins: ReadonlySet<string>,
): void {
  for (const label of labels) {
    let url: URL;
    try {
      url = new URL(label.labelUrl);
    } catch {
      throw new LabelConfigurationError();
    }
    if (url.protocol !== 'https:' || !allowedOrigins.has(url.origin)) {
      throw new LabelConfigurationError();
    }
  }
}

export async function downloadShipmentLabel(
  label: ShipmentLabel,
  allowedOrigins: ReadonlySet<string>,
  fetcher: LabelFetcher,
): Promise<DownloadedLabel> {
  assertAllowedLabelUrls([label], allowedOrigins);

  let response: Response;
  try {
    response = await fetcher(label.labelUrl, { redirect: 'error' });
  } catch {
    throw new LabelDownloadError();
  }
  if (!response.ok) throw new LabelDownloadError();

  const contentType = normalizeContentType(response.headers.get('content-type'));
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LABEL_BYTES) {
    throw new LabelDownloadError();
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LABEL_BYTES) {
    throw new LabelDownloadError();
  }
  return { bytes, ...contentType };
}

export function labelFilename(label: ShipmentLabel, extension: string): string {
  const reference = label.orderNumber ?? label.trackingNumber;
  const safeReference = reference.replace(/[^a-zA-Z0-9_-]+/gu, '-').replace(/^-|-$/gu, '');
  return `etiquette-${safeReference || label.shipmentId}.${extension}`;
}

function toShipmentLabel(row: ShipmentLabelRow): ShipmentLabel {
  return {
    labelUrl: row.label_url!,
    orderNumber: row.order_number,
    shipmentId: row.shipment_id,
    trackingNumber: row.tracking_number,
  };
}

function normalizeContentType(
  value: string | null,
): Pick<DownloadedLabel, 'contentType' | 'extension'> {
  const contentType = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType === 'application/pdf') return { contentType, extension: 'pdf' };
  if (contentType === 'image/png') return { contentType, extension: 'png' };
  if (contentType === 'image/jpeg') return { contentType, extension: 'jpg' };
  throw new LabelDownloadError();
}
