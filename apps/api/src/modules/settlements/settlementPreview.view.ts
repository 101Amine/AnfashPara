import { format, type SettlementPreview } from '@para/core';
import { html } from 'hono/html';

export type SettlementPreviewViewModel = {
  email: string;
  filename?: string;
  preview?: SettlementPreview;
  error?: string;
};

export function renderSettlementPreview(model: SettlementPreviewViewModel) {
  const preview = model.preview;
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <title>Aperçu des règlements · Anfash Para</title>
        <style>
          body {
            font: 16px system-ui;
            background: #f4f7f5;
            color: #18221d;
            margin: 0;
          }
          main {
            max-width: 1120px;
            margin: auto;
            padding: 24px 16px;
          }
          h1 {
            font-size: clamp(24px, 5vw, 36px);
          }
          .card {
            background: white;
            padding: 18px;
            border: 1px solid #dce5df;
            border-radius: 14px;
            margin: 16px 0;
          }
          label {
            display: block;
            margin-bottom: 12px;
          }
          input {
            max-width: 100%;
          }
          button,
          a {
            min-height: 44px;
            display: inline-flex;
            align-items: center;
          }
          button {
            background: #176b42;
            color: white;
            padding: 12px 18px;
            border: 0;
            border-radius: 8px;
            font: inherit;
            cursor: pointer;
          }
          .error {
            color: #9b302c;
          }
          .scroll {
            overflow-x: auto;
          }
          table {
            border-collapse: collapse;
            width: 100%;
          }
          th,
          td {
            text-align: left;
            border-bottom: 1px solid #dce5df;
            padding: 12px;
            white-space: nowrap;
          }
          dt {
            font-weight: bold;
          }
          dd {
            margin: 4px 0 16px;
          }
          .identity {
            overflow-wrap: anywhere;
          }
          @media (max-width: 600px) {
            main {
              padding: 16px 12px;
            }
            button {
              width: 100%;
            }
            .card {
              padding: 12px;
            }
          }
        </style>
      </head>
      <body>
        <main>
          <a href="/admin/orders">Retour aux commandes</a>
          <h1>Aperçu des règlements</h1>
          <p class="identity">Connecté·e : ${model.email}</p>
          <p>Aperçu uniquement : aucune commande ni donnée financière n’est modifiée.</p>
          <form
            class="card"
            method="post"
            action="/admin/settlements/preview"
            enctype="multipart/form-data"
          >
            <label for="statement">Relevé CSV (UTF-8, 1 Mio maximum, 1 000 lignes)</label>
            <input id="statement" type="file" name="file" accept=".csv,text/csv" required />
            <p>
              Colonnes : tracking_number, cod_collected, delivery_fee, return_fee, net_amount,
              courier_status. Montants en MAD, sans symbole de devise. Virgule ou point pour les
              décimales.
            </p>
            <button type="submit">Afficher l’aperçu</button>
          </form>
          ${model.error ? html`<p class="card error" role="alert">${model.error}</p>` : ''}
          ${
            preview
              ? html`<section class="card" aria-label="Résultat de validation">
                  <h2>${model.filename ?? 'Relevé'}</h2>
                  <p role="status">
                    ${preview.valid ? 'Fichier valide.' : 'Fichier invalide : corrigez les lignes signalées.'}
                    ${preview.rows.length} ligne(s) valide(s), ${preview.invalidRowCount} ligne(s)
                    rejetée(s).
                  </p>
                  <h3>Totaux des lignes valides uniquement</h3>
                  <dl>
                    <dt>Montant encaissé</dt>
                    <dd>${format(preview.totals.codCollectedCentimes)}</dd>
                    <dt>Frais de livraison</dt>
                    <dd>${format(preview.totals.deliveryFeeCentimes)}</dd>
                    <dt>Frais de retour</dt>
                    <dd>${format(preview.totals.returnFeeCentimes)}</dd>
                    <dt>Montant net déclaré</dt>
                    <dd>${format(preview.totals.netCentimes)}</dd>
                  </dl>
                  ${
                    preview.errors.length
                      ? html`<h3>Erreurs à corriger</h3>
                          <ul class="error" role="alert">
                            ${preview.errors.map((error) => html`<li>Ligne ${error.line} : ${error.message}</li>`)}
                          </ul>`
                      : ''
                  }
                  <div class="scroll">
                    <table>
                      <caption>
                        Lignes normalisées (montants affichés en MAD)
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Ligne</th>
                          <th scope="col">Suivi</th>
                          <th scope="col">Encaissé</th>
                          <th scope="col">Livraison</th>
                          <th scope="col">Retour</th>
                          <th scope="col">Net</th>
                          <th scope="col">Statut déclaré</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${preview.rows.map(
                          (row) =>
                            html`<tr>
                              <td>${row.line}</td>
                              <td>${row.trackingNumber}</td>
                              <td>${format(row.codCollectedCentimes)}</td>
                              <td>${format(row.deliveryFeeCentimes)}</td>
                              <td>${format(row.returnFeeCentimes)}</td>
                              <td>${format(row.netCentimes)}</td>
                              <td>${row.rawCourierStatus}</td>
                            </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>
                  <p>
                    Les statuts et montants déclarés ne sont pas encore rapprochés des commandes ou
                    du versement bancaire.
                  </p>
                </section>`
              : ''
          }
        </main>
      </body>
    </html>`;
}
