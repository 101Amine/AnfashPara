# Courier client port

`CourierClient` is the application-owned boundary between Anfash Para and any delivery company.
Core and shipping services accept this interface through dependency injection. They must not import a
courier SDK, its response types, or its exceptions directly.

```text
Shipping service → CourierClient ← ManualCourierClient (default/self-delivery)
                                ← FakeCourierClient (tests)
                                ← HttpCourierClient (optional API mode)
```

The port exposes two operations:

- `createParcel(input)` creates a parcel from normalized, server-owned order data.
- `getStatus(trackingNumber)` returns both the courier's raw status and our normalized status.

`FakeCourierClient` receives an explicit plan. Each operation therefore returns the configured value or
throws the configured `CourierClientError` deterministically. A missing tracking-number plan fails
explicitly instead of inventing data.

`ManualCourierClient` needs no account or secret. It creates a stable internal `SELF-*` tracking number
from the order and leaves status changes to an operator. This supports self-delivery, a courier with only
a portal, or paper-based operations. It never pretends to poll a remote delivery status.

API mode is opt-in through `COURIER_MODE=api`. No courier SDK is imported by core services.
