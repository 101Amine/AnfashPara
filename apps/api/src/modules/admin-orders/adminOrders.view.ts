// apps/api/src/modules/admin-orders/adminOrders.view.ts
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

import { ORDER_STATUSES } from '../../db/schema';
import type { AdminOrderListItem, AdminOrdersPage } from './adminOrders.repository';
import type { AdminOrdersQuery } from './adminOrders.schema';
import {
  buildWhatsAppConfirmationUrl,
  formatOrderDate,
  formatOrderMoney,
  formatSlaAge,
  getOrderStatusLabel,
} from './adminOrders.presenter';

type AdminOrdersViewModel = {
  identityEmail: string;
  now: Date;
  page: AdminOrdersPage;
  query: AdminOrdersQuery;
};

export async function renderAdminOrdersPage(
  model: AdminOrdersViewModel,
): Promise<HtmlEscapedString> {
  const nextPageUrl = buildNextPageUrl(model.query, model.page.nextCursor);

  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <title>File des commandes · Anfash Para</title>
        <style>
          :root {
            color-scheme: light;
            font-family:
              Inter,
              ui-sans-serif,
              system-ui,
              -apple-system,
              BlinkMacSystemFont,
              'Segoe UI',
              sans-serif;
            background: #f4f7f5;
            color: #18221d;
          }
          * {
            box-sizing: border-box;
          }
          body {
            margin: 0;
            background: #f4f7f5;
          }
          .shell {
            width: min(1120px, 100%);
            margin: 0 auto;
            padding: 20px 16px 48px;
          }
          header {
            display: flex;
            align-items: end;
            justify-content: space-between;
            gap: 18px;
            margin-bottom: 18px;
          }
          .eyebrow {
            color: #52705f;
            font-size: 12px;
            font-weight: 800;
            letter-spacing: 0.12em;
            text-transform: uppercase;
          }
          h1 {
            margin: 5px 0 0;
            font-size: clamp(26px, 5vw, 40px);
            letter-spacing: -0.04em;
          }
          .identity {
            color: #607067;
            font-size: 13px;
            text-align: right;
            overflow-wrap: anywhere;
          }
          .filters {
            display: grid;
            grid-template-columns: minmax(180px, 1fr) minmax(220px, 2fr) auto;
            gap: 10px;
            padding: 14px;
            margin-bottom: 14px;
            border: 1px solid #dce5df;
            border-radius: 16px;
            background: #fff;
            box-shadow: 0 8px 30px rgba(30, 58, 42, 0.06);
          }
          label {
            display: grid;
            gap: 6px;
            color: #526158;
            font-size: 12px;
            font-weight: 700;
          }
          input,
          select,
          button,
          .next {
            min-height: 44px;
            border-radius: 10px;
            font: inherit;
          }
          input,
          select {
            width: 100%;
            border: 1px solid #c9d6ce;
            background: #fff;
            padding: 0 12px;
            color: #18221d;
          }
          input:focus,
          select:focus {
            outline: 3px solid rgba(29, 126, 77, 0.18);
            border-color: #1d7e4d;
          }
          button,
          .next {
            border: 0;
            padding: 0 18px;
            align-self: end;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: #176b42;
            color: #fff;
            font-weight: 800;
            text-decoration: none;
            cursor: pointer;
          }
          .summary {
            margin: 12px 2px;
            color: #607067;
            font-size: 13px;
          }
          .batch-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            padding: 12px 14px;
            margin-bottom: 14px;
            border: 1px solid #dce5df;
            border-radius: 14px;
            background: #fff;
          }
          .batch-actions button {
            align-self: auto;
          }
          .orders {
            display: grid;
            gap: 10px;
          }
          .order {
            display: grid;
            grid-template-columns: 1.15fr 1fr 0.8fr auto;
            align-items: center;
            gap: 14px;
            padding: 16px;
            border: 1px solid #dce5df;
            border-radius: 16px;
            background: #fff;
            box-shadow: 0 5px 20px rgba(30, 58, 42, 0.045);
          }
          .order-number {
            font-size: 15px;
            font-weight: 850;
          }
          .customer {
            margin-top: 5px;
            color: #526158;
            font-size: 13px;
          }
          .phone {
            color: #24533a;
            font-weight: 700;
            text-decoration: none;
          }
          .meta-label {
            color: #78877e;
            font-size: 11px;
            font-weight: 750;
            letter-spacing: 0.06em;
            text-transform: uppercase;
          }
          .meta-value {
            margin-top: 4px;
            font-size: 13px;
            font-weight: 650;
          }
          .amount {
            white-space: nowrap;
            font-size: 15px;
            font-weight: 850;
            text-align: right;
          }
          .status-wrap {
            display: flex;
            flex-wrap: wrap;
            justify-content: flex-end;
            gap: 7px;
            margin-bottom: 8px;
          }
          .status,
          .sla {
            padding: 5px 8px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 850;
          }
          .status {
            background: #e7f3eb;
            color: #176b42;
          }
          .status.NO_ANSWER {
            background: #fff0cf;
            color: #8a5700;
          }
          .status.CANCELLED,
          .status.REFUSED {
            background: #fde8e7;
            color: #a03531;
          }
          .sla {
            background: #edf1f4;
            color: #455461;
          }
          .empty {
            padding: 42px 20px;
            border: 1px dashed #bfcfc5;
            border-radius: 16px;
            background: #fff;
            color: #607067;
            text-align: center;
          }
          .pagination {
            display: flex;
            justify-content: flex-end;
            margin-top: 16px;
          }
          .next {
            min-width: 160px;
          }
          .actions {
            grid-column: 1 / -1;
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            padding-top: 12px;
            border-top: 1px solid #edf1ee;
          }
          .actions form {
            margin: 0;
          }
          .action,
          .whatsapp {
            min-height: 40px;
            border-radius: 9px;
            padding: 0 13px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 13px;
            font-weight: 800;
            text-decoration: none;
          }
          .action-confirm {
            background: #176b42;
            color: #fff;
          }
          .action-parcel {
            background: #1d5bbf;
            color: #fff;
          }
          .action-label {
            background: #304f7a;
            color: #fff;
          }
          .label-choice {
            display: inline-flex;
            grid-template-columns: none;
            align-items: center;
            gap: 7px;
            min-height: 40px;
            padding: 0 10px;
            border: 1px solid #c9d6ce;
            border-radius: 9px;
            color: #31473a;
            font-size: 13px;
          }
          .label-choice input {
            width: auto;
          }
          .label-missing {
            display: inline-flex;
            align-items: center;
            min-height: 40px;
            color: #8a5700;
            font-size: 13px;
            font-weight: 750;
          }
          .action-missed,
          .action-callback {
            background: #fff3d9;
            color: #76500a;
          }
          .action-cancel {
            background: #fde8e7;
            color: #9b302c;
          }
          .whatsapp {
            margin-left: auto;
            background: #e0f7e9;
            color: #126b3d;
          }
          @media (max-width: 720px) {
            .shell {
              padding: 16px 12px 40px;
            }
            header {
              align-items: start;
              flex-direction: column;
            }
            .identity {
              text-align: left;
            }
            .filters {
              grid-template-columns: 1fr;
            }
            .filters button {
              width: 100%;
            }
            .batch-actions,
            .batch-actions button {
              width: 100%;
            }
            .order {
              grid-template-columns: 1fr 1fr;
            }
            .order-main {
              grid-column: 1 / -1;
            }
            .status-cell {
              grid-column: 1 / -1;
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 10px;
            }
            .status-wrap {
              justify-content: flex-start;
              margin: 0;
            }
            .amount {
              text-align: right;
            }
            .next {
              width: 100%;
            }
            .actions,
            .actions form,
            .action,
            .whatsapp {
              width: 100%;
            }
            .whatsapp {
              margin-left: 0;
            }
          }
        </style>
      </head>
      <body>
        <main class="shell">
          <header>
            <div>
              <div class="eyebrow">Administration · Anfash Para</div>
              <h1>File des commandes</h1>
            </div>
            <div class="identity">
              Connecté·e : ${model.identityEmail}<br />
              <a href="/admin/settlements">Aperçu des règlements</a>
              <a href="/admin/outbox">Tâches différées</a>
              <a href="/admin/dashboard">Tableau de bord</a>
              <a href="/admin/inventory">Stock</a>
            </div>
          </header>

          <form class="filters" method="get" action="/admin/orders">
            <label>
              Statut
              <select name="status">
                <option value="">Tous les statuts</option>
                ${ORDER_STATUSES.map((status) =>
                  model.query.status === status
                    ? html`<option value="${status}" selected>
                        ${getOrderStatusLabel(status)}
                      </option>`
                    : html`<option value="${status}">${getOrderStatusLabel(status)}</option>`,
                )}
              </select>
            </label>
            <label>
              Recherche
              <input
                type="search"
                name="q"
                value="${model.query.q}"
                placeholder="Téléphone ou n° de commande"
                autocomplete="off"
              />
            </label>
            <button type="submit">Filtrer</button>
          </form>

          <div class="summary">${model.page.orders.length} commande(s) sur cette page</div>

          <form id="label-batch-form" class="batch-actions" method="post">
            <button type="submit" formaction="/admin/labels/batch" formtarget="_blank">
              Imprimer les étiquettes sélectionnées
            </button>
            <button type="submit" formaction="/admin/labels/batch/download">
              Télécharger la sélection (.zip)
            </button>
          </form>

          <section class="orders" aria-label="Commandes">
            ${
              model.page.orders.length === 0
                ? html`<div class="empty">Aucune commande ne correspond à ces filtres.</div>`
                : model.page.orders.map((order) => {
                    const slaAge = formatSlaAge(order.status, order.statusStartedAt, model.now);
                    return html`<article class="order">
                      <div class="order-main">
                        <div class="order-number">${order.orderNumber ?? order.id}</div>
                        <div class="customer">
                          ${order.customerName ?? 'Client sans nom'} ·
                          <a class="phone" href="${`tel:${order.phoneE164}`}">${order.phoneE164}</a>
                        </div>
                      </div>
                      <div>
                        <div class="meta-label">Ville</div>
                        <div class="meta-value">${order.city ?? 'Non renseignée'}</div>
                      </div>
                      <div>
                        <div class="meta-label">Créée le</div>
                        <div class="meta-value">${formatOrderDate(order.placedAt)}</div>
                      </div>
                      <div class="status-cell">
                        <div class="status-wrap">
                          <span class="${`status ${order.status}`}">
                            ${getOrderStatusLabel(order.status)}
                          </span>
                          ${slaAge === null ? '' : html`<span class="sla">SLA · ${slaAge}</span>`}
                        </div>
                        <div class="amount">${formatOrderMoney(order.codAmountCentimes)}</div>
                      </div>
                      ${renderOrderActions(order)}
                    </article>`;
                  })
            }
          </section>

          ${
            nextPageUrl === null
              ? ''
              : html`<nav class="pagination" aria-label="Pagination">
                  <a class="next" href="${nextPageUrl}">Page suivante</a>
                </nav>`
          }
        </main>
      </body>
    </html>`;
}

function renderOrderActions(
  order: AdminOrderListItem,
): HtmlEscapedString | Promise<HtmlEscapedString> | string {
  const endpoint = `/admin/orders/${order.id}/confirmation`;
  const hasConfirmationActions = order.status === 'CONFIRMING' || order.status === 'NO_ANSWER';
  if (order.status !== 'CONFIRMED' && !hasConfirmationActions && order.shipmentId === null)
    return '';

  return html`<div class="actions" aria-label="Actions de la commande">
    ${
      order.status === 'CONFIRMED'
        ? html`<form method="post" action="${`/admin/orders/${order.id}/parcel`}">
            <button class="action action-parcel" type="submit">Créer le colis</button>
          </form>`
        : ''
    }
    ${
      hasConfirmationActions
        ? html`<form method="post" action="${endpoint}">
              <input type="hidden" name="action" value="confirmed" />
              <input type="hidden" name="channel" value="call" />
              <button class="action action-confirm" type="submit">Confirmé</button>
            </form>
            <form method="post" action="${endpoint}">
              <input type="hidden" name="action" value="no_answer" />
              <input type="hidden" name="channel" value="call" />
              <button class="action action-missed" type="submit">Pas de réponse</button>
            </form>
            <form method="post" action="${endpoint}">
              <input type="hidden" name="action" value="cancelled" />
              <input type="hidden" name="channel" value="call" />
              <button class="action action-cancel" type="submit">Annulé</button>
            </form>
            <form method="post" action="${endpoint}">
              <input type="hidden" name="action" value="callback" />
              <input type="hidden" name="channel" value="call" />
              <button class="action action-callback" type="submit">Rappeler</button>
            </form>
            <a
              class="whatsapp"
              href="${buildWhatsAppConfirmationUrl(order)}"
              target="_blank"
              rel="noopener noreferrer"
              >Ouvrir WhatsApp</a
            >`
        : ''
    }
    ${renderLabelActions(order)}
  </div>`;
}

function renderLabelActions(
  order: AdminOrderListItem,
): HtmlEscapedString | Promise<HtmlEscapedString> | string {
  if (order.shipmentId === null) return '';
  if (!order.shipmentLabelAvailable) {
    return html`<span class="label-missing">Étiquette indisponible</span>`;
  }

  const labelUrl = `/admin/shipments/${order.shipmentId}/label`;
  return html`<label class="label-choice">
      <input
        form="label-batch-form"
        type="checkbox"
        name="shipmentId"
        value="${order.shipmentId}"
      />
      Sélectionner
    </label>
    <a class="action action-label" href="${labelUrl}" target="_blank" rel="noopener">Voir</a>
    <a class="action action-label" href="${`${labelUrl}?download=1`}">Télécharger</a>`;
}

function buildNextPageUrl(query: AdminOrdersQuery, cursor: string | null): string | null {
  if (cursor === null) return null;

  const parameters = new URLSearchParams({ cursor });
  if (query.q !== '') parameters.set('q', query.q);
  if (query.status !== undefined) parameters.set('status', query.status);
  return `/admin/orders?${parameters.toString()}`;
}
