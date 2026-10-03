// apps/api/src/modules/inventory/inventoryOperations.view.ts
import { html } from 'hono/html';
import type { readInventoryOperations } from './inventoryOperations.service';
import type { InventoryOperation } from './inventoryOperations.schema';
const labels: Record<string, string> = {
  purchase: 'Réception',
  damaged: 'Endommagé',
  expired: 'Périmé',
  adjustment: 'Écart de comptage',
  shipped: 'Expédié',
  returned: 'Retourné',
};
export function renderInventoryOperations(
  data: Awaited<ReturnType<typeof readInventoryOperations>>,
  sku = '',
  reference = crypto.randomUUID(),
  message = '',
  draft?: InventoryOperation,
) {
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <title>Stock · Anfash Para</title>
        <style>
          body {
            font: 16px system-ui;
            background: #f4f7f5;
            margin: 0;
            color: #18221d;
          }
          main {
            max-width: 1000px;
            margin: auto;
            padding: 24px 16px;
          }
          section {
            background: white;
            padding: 16px;
            margin: 16px 0;
            border-radius: 12px;
          }
          label {
            display: block;
            margin: 12px 0;
          }
          input,
          select,
          textarea,
          button {
            font: inherit;
            box-sizing: border-box;
            padding: 10px;
            max-width: 100%;
            width: 100%;
          }
          button {
            background: #17643d;
            color: white;
            border: 0;
            cursor: pointer;
          }
          table {
            width: 100%;
            border-collapse: collapse;
          }
          th,
          td {
            text-align: left;
            padding: 10px;
            border-bottom: 1px solid #ddd;
            overflow-wrap: anywhere;
          }
          .scroll {
            overflow-x: auto;
          }
          nav {
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
          }
          a {
            color: #17643d;
          }
        </style>
      </head>
      <body>
        <main>
          <nav>
            <a href="/admin/orders">Commandes</a><a href="/admin/dashboard">Tableau de bord</a>
          </nav>
          <h1>Registre de stock</h1>
          ${message ? html`<p role="status">${message}</p>` : ''}
          <p>
            Stock physique issu des mouvements, sans réservation. Inspectez chaque retour avant
            remise en vente ; enregistrez une perte si endommagé ou périmé.
          </p>
          <section>
            <h2>Consulter un SKU</h2>
            <form method="get" action="/admin/inventory">
              <label>SKU<input name="sku" value="${sku}" maxlength="100" required /></label
              ><button>Voir le stock et l’historique</button>
            </form>
            <p>${sku ? 'SKU sélectionné' : '50 premiers SKU du catalogue'}</p>
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Produit</th>
                    <th>Stock physique</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.stock.map(
                    (r) =>
                      html`<tr>
                        <td>${r.sku}</td>
                        <td>${r.name}</td>
                        <td>${r.quantity}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h2>Ajouter un mouvement</h2>
            <form method="post" action="/admin/inventory/movements">
              <label>SKU<input name="sku" value="${sku}" maxlength="100" required /></label>
              <label
                >Motif<select name="reason">
                  ${Object.entries(labels)
                    .filter(([key]) => !['shipped', 'returned'].includes(key))
                    .map(
                      ([key, label]) =>
                        html`<option value="${key}" ${draft?.reason === key ? 'selected' : ''}>
                          ${label}
                        </option>`,
                    )}
                </select></label
              >
              <label
                >Quantité signée (écart, jamais total)<input
                  type="number"
                  name="quantity"
                  value="${draft?.quantity ?? ''}"
                  min="-100000"
                  max="100000"
                  step="1"
                  required
              /></label>
              <label
                >Référence stable<input
                  name="reference"
                  value="${reference}"
                  maxlength="100"
                  required
              /></label>
              <p>Gardez la même référence en cas de nouvelle soumission du même mouvement.</p>
              <label
                >Note opérateur<textarea name="note" maxlength="500" required>
${draft?.note ?? ''}</textarea></label
              ><button>Enregistrer le mouvement</button>
            </form>
          </section>
          <section>
            <h2>Historique ${sku}</h2>
            ${
              !sku
                ? html`<p>Sélectionnez un SKU pour consulter son historique.</p>`
                : !data.history.length
                  ? html`<p>Aucun mouvement.</p>`
                  : html`<div class="scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Quantité</th>
                            <th>Motif</th>
                            <th>Référence</th>
                            <th>Opérateur</th>
                            <th>Note</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${data.history.map(
                            (r) =>
                              html`<tr>
                                <td>${r.created_at}</td>
                                <td>${r.quantity}</td>
                                <td>${labels[r.reason] ?? r.reason}</td>
                                <td>${r.reference ?? '—'}</td>
                                <td>${r.actor ?? 'Automatique / historique'}</td>
                                <td>${r.note ?? '—'}</td>
                              </tr>`,
                          )}
                        </tbody>
                      </table>
                    </div>`
            }
            ${data.nextCursor ? html`<a href="${'/admin/inventory?' + new URLSearchParams({ sku, cursor: data.nextCursor })}">Mouvements plus anciens</a>` : ''}
          </section>
        </main>
      </body>
    </html>`;
}
