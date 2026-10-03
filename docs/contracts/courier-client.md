# Courier client port

`CourierClient` is the application-owned boundary between Anfash Para and any delivery company.
Core and shipping services accept this interface through dependency injection. They must not import a
courier SDK, its response types, or its exceptions directly.

```text
Shipping service → CourierClient ← FakeCourierClient (tests/local)
                                ← Future real courier adapter
```

The port exposes two operations:

- `createParcel(input)` creates a parcel from normalized, server-owned order data.
- `getStatus(trackingNumber)` returns both the courier's raw status and our normalized status.

`FakeCourierClient` receives an explicit plan. Each operation therefore returns the configured value or
throws the configured `CourierClientError` deterministically. A missing tracking-number plan fails
explicitly instead of inventing data.

No production credentials or courier SDK are part of this module.
