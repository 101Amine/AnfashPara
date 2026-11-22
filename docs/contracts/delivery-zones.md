# Customer delivery zones

Initial policy chosen on 22 November 2026 under the owner's request for reasonable
local rates: Rabat 20 MAD, Salé 20 MAD, Témara 25 MAD. No free-delivery threshold.
These are customer charges, not a courier quote or a promise of delivery times.
Other surrounding places are not implicitly included. Add them deliberately.

The versioned policy lives in `packages/core/src/delivery.ts`. Keeping three rates
in reviewed code avoids a new database/configuration editor before one is needed.
Changing a rate requires a reviewed deployment and policy-version update.

`GET /api/delivery-zones` returns currency, policy version, a null free-delivery
threshold and `zones: [{ id, city, feeCentimes }]`. Responses may be cached for
60 seconds. The storefront should populate its city selector from this response
and show the fee before submission. It must not describe unlisted towns as served.

`POST /api/orders` accepts an ID or canonical city name in `customer.city`.
Whitespace, case and accents are normalized; there is no fuzzy/suburb matching.
The backend resolves the fee, canonicalizes the saved city and adds the charge to
the same D1 product-price snapshot used to freeze order items. The fee, total and
reservation are committed in the existing order transaction. Client-supplied fee
or total fields are rejected by the strict payload schema.

The receipt includes `itemsSubtotalCentimes`, `shippingFeeCustomerCentimes` and
`codAmountCentimes`. Replay returns the stored amounts without repricing, even for
historical zero-shipping orders. Failed and successful order responses are private
and not cacheable. Unsupported cities return 422 `unsupported_delivery_zone`
before any customer/order/inbox writes.

Signed internal ingestion retains its explicit shipping fee contract; its caller
is trusted through signature verification. Courier delivery/return costs remain
separate shipment fields for settlement reconciliation.

Remaining storefront work: use the city selector, display the fee and COD total,
and explain an unavailable city. This backend change does not finish that UI.
