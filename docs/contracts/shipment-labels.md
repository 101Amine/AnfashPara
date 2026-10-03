# Shipment labels

All label routes live under `/admin/*`, so Cloudflare Access and the Worker's JWT verification run
before label metadata is queried or courier bytes are fetched.

## Routes

- `GET /admin/shipments/:shipmentId/label` streams one PDF, PNG, or JPEG inline.
- Add `?download=1` to force an authenticated file download.
- `POST /admin/labels/batch` accepts 1–20 `shipmentId` form fields and renders a printable page.
- `POST /admin/labels/batch/download` downloads the same selection as an uncompressed ZIP.

The admin order queue exposes a checkbox, View, and Download controls only when a shipment has a
stored label. A shipment without one returns `409 label_missing` with its order reference instead of
a broken or empty response.

## Security boundaries

Stored courier URLs are never rendered into admin HTML. The Worker proxies the bytes and accepts only
HTTPS origins listed in the comma-separated `COURIER_LABEL_ORIGINS` binding. Redirects, unsupported
content types, failed upstream responses, empty files, and labels larger than 5 MB are rejected with a
controlled error. Batch downloads are capped at 25 MB. Responses use private no-store caching.

Real courier credentials and signed label URLs are never committed. When a carrier is selected, add
its exact label origin through Worker configuration.
