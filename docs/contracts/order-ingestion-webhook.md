# Order ingestion webhook

`POST /api/webhooks/orders` is a server-to-server ingestion endpoint. A browser must never receive its HMAC secret. The future storefront browser should use the public order API instead.

## Authentication

The sender signs the exact UTF-8 request body with HMAC-SHA-256 using `ORDER_WEBHOOK_SECRET` and sends the lowercase hexadecimal digest as:

```http
X-Para-Signature: sha256=<64 hexadecimal characters>
```

The Worker verifies this signature before parsing JSON. Changing whitespace after signing changes the signature.

## Payload

```json
{
  "eventId": "event-order-1001",
  "order": {
    "externalId": "storefront-order-1001",
    "orderNumber": "PARA-1001",
    "placedAt": "2026-10-03T10:00:00.000Z",
    "shippingFeeCustomerCentimes": 3000,
    "customer": {
      "name": "Salma Test",
      "phone": "06 12 34 56 78",
      "city": "Rabat",
      "address": "12 rue Exemple, Agdal",
      "note": "Appeler avant livraison"
    },
    "items": [
      { "sku": "BIO-OIL-125ML", "quantity": 2 },
      { "sku": "MUSTELA-250ML", "quantity": 1 }
    ],
    "attribution": {
      "utmSource": "instagram",
      "utmCampaign": "launch",
      "utmContent": "video-01"
    }
  }
}
```

Client-supplied prices and COGS are intentionally absent. The API reads both from D1 and freezes them on each `order_items` row.

## Responses

- First successful delivery: HTTP `201` with `{ "duplicate": false, "orderId": "...", "status": "CONFIRMING" }`.
- Repeated `eventId`: HTTP `200` with `{ "duplicate": true }`.
- Invalid signature: HTTP `401`.
- Invalid JSON or schema: HTTP `400`.
- Invalid phone or unavailable SKU: HTTP `422`.

The successful D1 batch atomically writes the inbox entry, customer upsert, order, items, `NEW → CONFIRMING` event, and confirmation outbox message.
