// apps/api/src/modules/dashboard/dashboard.view.ts
import { html } from 'hono/html';
import type { DashboardData } from './dashboard.repository';
import { dashboardMoney, refusalRate } from './dashboard.presenter';

export function renderDashboard(data: DashboardData) {
  const date = (value: string) =>
    new Intl.DateTimeFormat('fr-MA', {
      timeZone: data.week.timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <title>Tableau de bord · Anfash Para</title>
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
          nav {
            display: flex;
            flex-wrap: wrap;
            gap: 16px;
          }
          a {
            color: #17643d;
          }
          .cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 12px;
          }
          article,
          section {
            background: white;
            border: 1px solid #d9e3dd;
            border-radius: 12px;
            padding: 16px;
            margin: 16px 0;
          }
          article strong {
            display: block;
            font-size: 2rem;
          }
          .scroll {
            overflow-x: auto;
          }
          table {
            width: 100%;
            border-collapse: collapse;
          }
          th,
          td {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid #e1e8e3;
            overflow-wrap: anywhere;
          }
          p {
            line-height: 1.5;
          }
          .muted {
            color: #526359;
          }
          h2 {
            font-size: 1.2rem;
          }
        </style>
      </head>
      <body>
        <main>
          <nav aria-label="Administration">
            <a href="/admin/orders">Commandes</a><a href="/admin/settlements">Règlements</a
            ><a href="/admin/outbox">Tâches différées</a>
          </nav>
          <h1>Tableau de bord</h1>
          <p class="muted">
            Semaine du ${date(data.week.start)} au ${date(data.week.end)} · Africa/Casablanca.<br />Actualisé
            : ${date(data.week.asOf)}.
          </p>
          <div class="cards">
            ${[
              ['Commandes reçues', data.metrics.placed],
              ['Confirmées', data.metrics.confirmed],
              ['Livrées', data.metrics.delivered],
              ['Refusées', data.metrics.refused],
            ].map(([label, count]) => html`<article>${label}<strong>${count}</strong></article>`)}
          </div>
          <p>
            Activité de la semaine : date de commande, de confirmation ou d’événement. Une commande
            peut avoir été reçue une semaine précédente.
          </p>
          <section>
            <h2>Versement transporteur attendu</h2>
            ${data.payout.eligible === 0 ? html`<p>Aucune livraison en attente de rapprochement.</p>` : html`<p><strong>${dashboardMoney(data.payout.netCentimes)}</strong> · ${data.payout.eligible} livraison(s) non rapprochée(s).</p>`}
            <p>${data.payout.unknownFees} livraison(s) exclue(s) du montant : frais inconnus.</p>
            <p class="muted">
              Toutes périodes. COD moins frais de livraison connus. Hors frais de retour et relevés
              déjà rapprochés. Ce montant n’est pas une réception bancaire.
            </p>
          </section>
          <section>
            <h2>Refus par produit</h2>
            <p>
              20 premiers produits, taux décroissant. Refus / commandes avec issue livrée ou refusée
              cette semaine ; chaque commande compte une fois par SKU.
            </p>
            ${
              data.refusals.length === 0
                ? html`<p>Aucune issue de livraison cette semaine.</p>`
                : html`<div class="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>SKU</th>
                          <th>Issues</th>
                          <th>Refus</th>
                          <th>Taux</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${data.refusals.map(
                          (r) =>
                            html`<tr>
                              <td>${r.sku}</td>
                              <td>${r.outcomes}</td>
                              <td>${r.refused}</td>
                              <td>${refusalRate(r.refused, r.outcomes)}</td>
                            </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>`
            }
          </section>
          <section>
            <h2>Campagnes et contenus</h2>
            <p>
              20 premières contributions aux commandes reçues cette semaine. COD commandé, pas un
              revenu encaissé.
            </p>
            ${
              data.campaigns.length === 0
                ? html`<p>Aucune commande attribuable cette semaine.</p>`
                : html`<div class="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Campagne</th>
                          <th>utm_content</th>
                          <th>Commandes</th>
                          <th>COD</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${data.campaigns.map(
                          (r) =>
                            html`<tr>
                              <td>${r.campaign ?? 'Non attribuée'}</td>
                              <td>${r.content ?? 'Non attribué'}</td>
                              <td>${r.orders}</td>
                              <td>${dashboardMoney(r.codCentimes)}</td>
                            </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>`
            }
          </section>
          <section>
            <h2>Stock issu du registre</h2>
            <p>
              50 premiers SKU, actifs ou non. Somme des mouvements, toutes périodes ; sans
              réservation.
            </p>
            ${
              data.stock.length === 0
                ? html`<p>Aucun produit dans le catalogue.</p>`
                : html`<div class="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>SKU</th>
                          <th>Produit</th>
                          <th>Stock</th>
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
                  </div>`
            }
          </section>
        </main>
      </body>
    </html>`;
}
