// apps/api/src/modules/settlements/reconciliation.service.ts
import {
  add,
  parse,
  parseSettlementCsv,
  reconcileSettlement,
  transition,
  type ReconciliationReport,
  type ReconciliationShipment,
} from '@para/core';
import { createUuidV7 } from '../../shared/uuidV7';
import type { ReconciliationInput } from './reconciliation.schema';

const STORE = 'para-main';
export class ReconciliationError extends Error {
  constructor(
    readonly code:
      | 'invalid_csv'
      | 'statement_conflict'
      | 'stale_preview'
      | 'payment_mismatch'
      | 'legacy_statement',
    message: string,
  ) {
    super(message);
  }
}
export interface ApprovedReport {
  report: ReconciliationReport;
  approval: string;
  contentHash: string;
}
type ExistingStatement = { id: string; content_hash: string | null; report_json: string | null };

async function hash(value: unknown): Promise<string> {
  const result = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function existing(database: D1Database, input: ReconciliationInput) {
  return database
    .prepare(
      `SELECT id, content_hash, report_json FROM courier_settlements
    WHERE store_id = ? AND courier = ? AND statement_reference = ?`,
    )
    .bind(STORE, input.courier, input.statementReference)
    .first<ExistingStatement>();
}

export async function previewReconciliation(
  database: D1Database,
  input: ReconciliationInput,
): Promise<ApprovedReport> {
  const preview = parseSettlementCsv(input.source);
  if (!preview.valid)
    throw new ReconciliationError(
      'invalid_csv',
      'Corrigez toutes les erreurs du CSV avant le rapprochement.',
    );
  const shipments: ReconciliationShipment[] = [];
  // Bounded indexed lookups, chunked below SQLite's bind-variable limit.
  const tracking = [...new Set(preview.rows.map((row) => row.trackingNumber))];
  for (let offset = 0; offset < tracking.length; offset += 80) {
    const chunk = tracking.slice(offset, offset + 80);
    const found = await database
      .prepare(
        `SELECT s.id AS shipmentId, s.tracking_number AS trackingNumber,
      s.status_normalized AS shipmentStatus, s.delivery_fee_centimes AS deliveryFeeCentimes,
      s.return_fee_centimes AS returnFeeCentimes, o.id AS orderId, o.status AS orderStatus,
      o.cod_amount_centimes AS codCentimes,
      EXISTS(SELECT 1 FROM settlement_lines l WHERE l.store_id = s.store_id AND l.shipment_id = s.id AND l.line_status = 'matched') AS previouslyMatched
      FROM shipments s JOIN orders o ON o.id = s.order_id AND o.store_id = s.store_id
      WHERE s.store_id = ? AND s.courier = ? AND s.tracking_number IN (${chunk.map(() => '?').join(',')})`,
      )
      .bind(STORE, input.courier, ...chunk)
      .all<Omit<ReconciliationShipment, 'previouslyMatched'> & { previouslyMatched: number }>();
    shipments.push(
      ...found.results.map((row) => ({ ...row, previouslyMatched: row.previouslyMatched === 1 })),
    );
  }
  const report = reconcileSettlement(preview, shipments, parse(input.amountPaid));
  const contentHash = await hash({
    ...input,
    source: preview.rows,
    amountPaid: parse(input.amountPaid),
  });
  return { report, contentHash, approval: await hash({ contentHash, report }) };
}

function duplicateResult(row: ExistingStatement, contentHash: string) {
  if (!row.content_hash || !row.report_json)
    throw new ReconciliationError(
      'legacy_statement',
      'Ce relevé existe déjà sans aperçu enregistré. Vérifiez la référence.',
    );
  if (row.content_hash !== contentHash)
    throw new ReconciliationError(
      'statement_conflict',
      'Cette référence existe avec un contenu différent.',
    );
  return {
    duplicate: true,
    settlementId: row.id,
    report: JSON.parse(row.report_json) as ReconciliationReport,
  };
}

export async function importReconciliation(
  database: D1Database,
  input: ReconciliationInput,
  approval: string,
  adminEmail: string,
  now = new Date(),
) {
  // Never trust client report fields: reparse and reload authoritative prices, fees and states.
  const current = await previewReconciliation(database, input);
  const prior = await existing(database, input);
  if (prior) return duplicateResult(prior, current.contentHash);
  if (!approval || approval !== current.approval)
    throw new ReconciliationError(
      'stale_preview',
      'Les données ont changé. Recommencez l’aperçu et approuvez-le.',
    );
  if (current.report.statementVarianceCentimes !== 0)
    throw new ReconciliationError(
      'payment_mismatch',
      'Le montant reçu ne correspond pas au total net du relevé. Aucun import effectué.',
    );
  const id = createUuidV7(now.getTime());
  const timestamp = now.toISOString();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO courier_settlements
    (id,store_id,courier,statement_reference,period_start,period_end,amount_paid_centimes,imported_at,source_file,content_hash,report_json,imported_by)
    VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?)`,
      )
      .bind(
        id,
        STORE,
        input.courier,
        input.statementReference,
        input.periodStart,
        input.periodEnd,
        current.report.amountPaidCentimes,
        timestamp,
        current.contentHash,
        JSON.stringify(current.report),
        adminEmail,
      ),
  ];
  // A NOT NULL assertion inside the transaction rolls back the entire batch on a race.
  for (const line of current.report.lines) {
    const shipment = line.shipment;
    const guard = shipment
      ? `EXISTS(SELECT 1 FROM shipments s JOIN orders o ON o.id=s.order_id AND o.store_id=s.store_id
          WHERE s.id=? AND s.store_id=? AND s.courier=? AND s.tracking_number=? AND o.id=?
          AND o.status=? AND o.cod_amount_centimes=? AND s.status_normalized=?
          AND s.delivery_fee_centimes IS ? AND s.return_fee_centimes IS ?
          AND EXISTS(SELECT 1 FROM settlement_lines l WHERE l.store_id=s.store_id AND l.shipment_id=s.id AND l.line_status='matched')=?)`
      : `NOT EXISTS(SELECT 1 FROM shipments WHERE store_id=? AND courier=? AND tracking_number=?)`;
    const guardArgs = shipment
      ? [
          shipment.shipmentId,
          STORE,
          input.courier,
          line.trackingNumber,
          shipment.orderId,
          shipment.orderStatus,
          shipment.codCentimes,
          shipment.shipmentStatus,
          shipment.deliveryFeeCentimes,
          shipment.returnFeeCentimes,
          shipment.previouslyMatched ? 1 : 0,
        ]
      : [STORE, input.courier, line.trackingNumber];
    statements.push(
      database
        .prepare(
          `INSERT INTO settlement_lines
      (id,store_id,settlement_id,tracking_number,cod_collected_centimes,fee_centimes,net_centimes,expected_fee_centimes,line_status,shipment_id,created_at)
      VALUES (CASE WHEN ${guard} THEN ? ELSE NULL END,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          ...guardArgs,
          createUuidV7(now.getTime()),
          STORE,
          id,
          line.trackingNumber,
          line.codCollectedCentimes,
          add(line.deliveryFeeCentimes, line.returnFeeCentimes),
          line.netCentimes,
          line.expectedFeeCentimes ?? 0,
          line.classification === 'exact'
            ? 'matched'
            : ['variance', 'variance_over_100'].includes(line.classification)
              ? 'fee_mismatch'
              : 'unmatched',
          shipment?.shipmentId ?? null,
          timestamp,
        ),
    );
  }
  // All guards run before changing orders; duplicates share one original snapshot.
  for (const line of current.report.lines.filter((row) => row.classification === 'exact')) {
    const shipment = line.shipment!;
    const result = transition(
      { id: shipment.orderId, status: shipment.orderStatus, noAnswerAttempts: 0 },
      'SETTLED',
      {
        actor: 'reconciliation',
        reason: 'settlement_matched',
        payload: {
          settlementId: id,
          trackingNumber: line.trackingNumber,
          approvedBy: adminEmail,
          netCentimes: line.netCentimes,
        },
      },
    );
    statements.push(
      database
        .prepare(
          `UPDATE orders SET status=?, updated_at=?, closed_at=COALESCE(closed_at,?) WHERE id=? AND store_id=?`,
        )
        .bind(result.next.status, timestamp, timestamp, shipment.orderId, STORE),
    );
    statements.push(
      database
        .prepare(
          `INSERT INTO order_events (id,store_id,order_id,from_status,to_status,actor,reason,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          createUuidV7(now.getTime()),
          STORE,
          shipment.orderId,
          result.event.fromStatus,
          result.event.toStatus,
          result.event.actor,
          result.event.reason!,
          JSON.stringify(result.event.payload),
          timestamp,
        ),
    );
  }
  try {
    await database.batch(statements);
  } catch (error) {
    const raced = await existing(database, input);
    if (raced) return duplicateResult(raced, current.contentHash);
    if (String(error).includes('NOT NULL constraint failed: settlement_lines.id'))
      throw new ReconciliationError(
        'stale_preview',
        'Les données ont changé pendant l’import. Aucun changement enregistré.',
      );
    throw error;
  }
  return { duplicate: false, settlementId: id, report: current.report };
}

export async function loadSettlementReport(database: D1Database, id: string) {
  const row = await database
    .prepare('SELECT id, report_json FROM courier_settlements WHERE id=? AND store_id=?')
    .bind(id, STORE)
    .first<{ id: string; report_json: string | null }>();
  if (!row) return null;
  if (row.report_json)
    return {
      settlementId: id,
      report: JSON.parse(row.report_json) as ReconciliationReport,
      legacyLines: null,
    };
  const legacy = await database
    .prepare(
      `SELECT tracking_number, cod_collected_centimes, fee_centimes,
    net_centimes, expected_fee_centimes, line_status FROM settlement_lines WHERE settlement_id=? AND store_id=? ORDER BY id`,
    )
    .bind(id, STORE)
    .all<LegacySettlementLine>();
  return { settlementId: id, report: null, legacyLines: legacy.results };
}

export interface LegacySettlementLine {
  tracking_number: string;
  cod_collected_centimes: number;
  fee_centimes: number;
  net_centimes: number;
  expected_fee_centimes: number;
  line_status: string;
}

export async function listSettlementReports(database: D1Database) {
  return (
    await database
      .prepare(
        `SELECT id,courier,statement_reference,amount_paid_centimes,imported_at
    FROM courier_settlements WHERE store_id=? ORDER BY imported_at DESC,id DESC LIMIT 30`,
      )
      .bind(STORE)
      .all<{
        id: string;
        courier: string;
        statement_reference: string;
        amount_paid_centimes: number;
        imported_at: string;
      }>()
  ).results;
}
