// apps/api/src/modules/labels/labels.view.ts
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

import type { ShipmentLabel } from './labels.service';

export function renderLabelBatchPage(
  labels: ShipmentLabel[],
): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <title>Étiquettes sélectionnées · Anfash Para</title>
        <style>
          * {
            box-sizing: border-box;
          }
          body {
            margin: 0;
            background: #eef2ef;
            color: #18221d;
            font-family: system-ui, sans-serif;
          }
          .toolbar {
            position: sticky;
            top: 0;
            z-index: 2;
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            align-items: center;
            padding: 14px;
            background: #fff;
            border-bottom: 1px solid #dce5df;
          }
          button,
          a {
            min-height: 42px;
            display: inline-flex;
            align-items: center;
            padding: 0 15px;
            border: 0;
            border-radius: 9px;
            background: #176b42;
            color: #fff;
            font: inherit;
            font-weight: 800;
            text-decoration: none;
            cursor: pointer;
          }
          a {
            background: #526158;
          }
          .labels {
            width: min(900px, 100%);
            margin: 18px auto;
            display: grid;
            gap: 18px;
          }
          .label {
            min-height: 600px;
            padding: 12px;
            background: #fff;
            page-break-after: always;
          }
          .label h2 {
            margin: 0 0 10px;
            font-size: 15px;
          }
          iframe {
            width: 100%;
            height: 760px;
            border: 1px solid #dce5df;
          }
          @media print {
            body {
              background: #fff;
            }
            .toolbar {
              display: none;
            }
            .labels {
              width: 100%;
              margin: 0;
              gap: 0;
            }
            .label {
              padding: 0;
            }
            .label h2 {
              display: none;
            }
            iframe {
              height: 100vh;
              border: 0;
            }
          }
        </style>
      </head>
      <body>
        <div class="toolbar">
          <strong>${labels.length} étiquette(s)</strong>
          <button type="button" onclick="window.print()">Imprimer la sélection</button>
          <a href="/admin/orders">Retour aux commandes</a>
        </div>
        <main class="labels">
          ${labels.map(
            (label) =>
              html`<section class="label">
                <h2>${label.orderNumber ?? label.trackingNumber}</h2>
                <iframe
                  title="${`Étiquette ${label.orderNumber ?? label.trackingNumber}`}"
                  src="${`/admin/shipments/${label.shipmentId}/label`}"
                ></iframe>
              </section>`,
          )}
        </main>
      </body>
    </html>`;
}
