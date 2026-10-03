// apps/api/src/modules/settlements/reconciliation.view.ts
import {
  cents,
  format,
  type ReconciliationClassification,
  type ReconciliationReport,
} from '@para/core';
import { html } from 'hono/html';
import type { ReconciliationInput } from './reconciliation.schema';
import type { LegacySettlementLine } from './reconciliation.service';

const labels: Record<ReconciliationClassification, string> = {
  exact: 'Correspondance exacte',
  unmatched: 'Suivi introuvable',
  duplicate: 'Doublon / déjà rapproché',
  status_conflict: 'Statut incompatible',
  missing_fee: 'Frais attendus inconnus',
  variance: 'Écart (même inférieur à 1 MAD)',
  variance_over_100: 'Écart supérieur à 1 MAD',
};
const money = (value: number | null) => (value === null ? 'Inconnu' : format(cents(value)));

export function renderReconciliation(model: {
  email: string;
  input?: ReconciliationInput;
  report?: ReconciliationReport;
  approval?: string;
  settlementId?: string;
  error?: string;
  duplicate?: boolean;
}) {
  const { input, report } = model;
  const rows = report?.lines.map(
    (line) =>
      html`<tr>
        <td>${line.line}</td>
        <td>${line.trackingNumber}</td>
        <td>${line.rawCourierStatus}</td>
        <td>${labels[line.classification]}</td>
        <td>${money(line.expectedNetCentimes)}</td>
        <td>${money(line.netCentimes)}</td>
        <td>${money(line.varianceCentimes)}</td>
      </tr>`,
  );
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <title>Rapprochement des règlements · Anfash Para</title>
        <style>
          body {
            font: 16px system-ui;
            background: #f4f7f5;
            color: #18221d;
            margin: 0;
          }
          main {
            max-width: 1100px;
            margin: auto;
            padding: 24px 16px;
          }
          section {
            background: white;
            padding: 18px;
            border-radius: 12px;
            margin: 16px 0;
          }
          label {
            display: block;
            margin: 12px 0;
          }
          input,
          button {
            font: inherit;
            max-width: 100%;
            min-height: 44px;
          }
          button {
            background: #176b42;
            color: white;
            border: 0;
            padding: 12px;
            border-radius: 8px;
          }
          .scroll {
            overflow-x: auto;
          }
          table {
            border-collapse: collapse;
            width: 100%;
          }
          td,
          th {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid #ddd;
            white-space: nowrap;
          }
          .error {
            color: #9b302c;
          }
          p {
            overflow-wrap: anywhere;
          }
        </style>
      </head>
      <body>
        <main>
          <a href="/admin/settlements">Aperçu CSV</a> · <a href="/admin/orders">Commandes</a>
          <h1>Rapprochement des règlements</h1>
          <p>${model.email}</p>
          <p>
            Livreur « manual » pour vos livraisons. Seules les correspondances exactes livrées
            seront réglées. Les exceptions restent à vérifier.
          </p>
          <a href="/admin/settlements/reports">Relevés importés</a>
          ${model.error ? html`<p role="alert" class="error">${model.error}</p>` : ''}
          ${model.settlementId ? html`<p role="status">${model.duplicate ? 'Relevé déjà importé : aucun nouvel effet.' : 'Relevé importé.'} <a href="/admin/settlements/reports/${model.settlementId}">Rapport enregistré</a></p>` : ''}
          ${
            !report
              ? html`<section>
                  <form
                    action="/admin/settlements/reconcile"
                    method="post"
                    enctype="multipart/form-data"
                  >
                    <label
                      >Livreur <input name="courier" value="manual" required maxlength="128"
                    /></label>
                    <label
                      >Référence unique du relevé
                      <input name="statementReference" required maxlength="128"
                    /></label>
                    <label>Début <input type="date" name="periodStart" required /></label
                    ><label>Fin <input type="date" name="periodEnd" required /></label>
                    <label
                      >Montant reçu (MAD) <input name="amountPaid" inputmode="decimal" required
                    /></label>
                    <label
                      >Relevé CSV <input type="file" name="file" accept=".csv" required
                    /></label>
                    <button>Aperçu du rapprochement</button>
                  </form>
                </section>`
              : ''
          }
          ${
            report
              ? html`<section>
                  <h2>Totaux du relevé</h2>
                  <p>
                    Encaissement COD : ${money(report.totals.codCollectedCentimes)} · Livraison :
                    ${money(report.totals.deliveryFeeCentimes)} · Retour :
                    ${money(report.totals.returnFeeCentimes)}
                  </p>
                  <p>
                    Net déclaré : ${money(report.totals.netCentimes)} · Net attendu connu (suivis
                    uniques) : ${money(report.expectedNetCentimes)}
                  </p>
                  <p>
                    Montant reçu confirmé : ${money(report.amountPaidCentimes)} · Écart relevé /
                    reçu : ${money(report.statementVarianceCentimes)}
                  </p>
                  <p>
                    ${report.exactCount} correspondances exactes · ${report.exceptionCount}
                    exceptions.
                  </p>
                  <div class="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Ligne</th>
                          <th>Suivi</th>
                          <th>Statut brut</th>
                          <th>Résultat</th>
                          <th>Net attendu</th>
                          <th>Net déclaré</th>
                          <th>Écart</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${rows}
                      </tbody>
                    </table>
                  </div>
                </section>`
              : ''
          }
          ${
            input && model.approval && !model.settlementId
              ? html`<section>
                  <form
                    action="/admin/settlements/import"
                    method="post"
                    enctype="multipart/form-data"
                  >
                    ${(['courier', 'statementReference', 'periodStart', 'periodEnd', 'amountPaid'] as const).map((name) => html`<input type="hidden" name="${name}" value="${input[name]}" />`)}
                    <textarea hidden name="source">${input.source}</textarea
                    ><input type="hidden" name="approval" value="${model.approval}" />
                    <label
                      ><input type="checkbox" name="confirmed" value="true" required /> J’ai vérifié
                      ce relevé et le montant réellement reçu. J’approuve l’import et le règlement
                      des lignes exactes.</label
                    >
                    <p>
                      Aucune vérification bancaire automatique. Les lignes en exception ne seront
                      pas réglées.
                    </p>
                    <button ${report?.statementVarianceCentimes !== 0 ? 'disabled' : ''}>
                      Approuver et importer
                    </button>
                  </form>
                </section>`
              : ''
          }
          <a href="/admin/settlements/reconcile">Nouveau rapprochement</a>
        </main>
      </body>
    </html>`;
}

export function renderLegacySettlement(email: string, id: string, lines: LegacySettlementLine[]) {
  return html`<!doctype html>
    <html lang="fr">
      <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>Ancien relevé · Anfash Para</title>
      <body style="font:16px system-ui;padding:16px">
        <a href="/admin/settlements/reports">Relevés</a>
        <h1>Ancien relevé</h1>
        <p>${email} · ${id}</p>
        <p>
          Lecture seule. Ancien format : frais combinés, statut brut et approbation indisponibles.
          Aucune commande n’est modifiée.
        </p>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>Suivi</th>
                <th>Résultat enregistré</th>
                <th>Frais déclarés</th>
                <th>Frais attendus</th>
                <th>Écart frais</th>
                <th>Net déclaré</th>
              </tr>
            </thead>
            <tbody>
              ${lines.map(
                (line) =>
                  html`<tr>
                    <td>${line.tracking_number}</td>
                    <td>
                      ${line.line_status === 'fee_mismatch' ? 'Exception : frais incorrects' : line.line_status}
                    </td>
                    <td>${money(line.fee_centimes)}</td>
                    <td>${money(line.expected_fee_centimes)}</td>
                    <td>${money(line.fee_centimes - line.expected_fee_centimes)}</td>
                    <td>${money(line.net_centimes)}</td>
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>
      </body>
    </html>`;
}
