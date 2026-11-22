# Manual WhatsApp messages

At launch an authenticated human administrator opens the order's **Messages WhatsApp et suivi** page from `/admin/orders`.

1. Check the proposed French message and recipient, then open WhatsApp.
2. Review and send the message yourself in WhatsApp.
3. Return and select **J’ai envoyé ce message** only after sending.
4. For confirmation, record the customer's outcome separately. This uses the existing confirmation workflow with channel `whatsapp`.

Templates are available for CONFIRMING/NO_ANSWER (confirmation), SHIPPED (shipment notice), and CANCELLED (cancellation). They use the stored order reference and COD amount. They do not promise an unconfigured delivery date.

Opening the page or WhatsApp link writes nothing. A send declaration creates a same-status `order_events` record with reason `whatsapp_sent_manual`, the administrator, time, template identifier and version. It is an administrator declaration, **not** a WhatsApp delivery/read receipt or a copy of the final edited message. It does not confirm the order, increment confirmation attempts, reset its SLA age, or complete outbox work.

Repeated submission of the same form event ID is idempotent. An order status change rejects an unrecorded stale form. A fresh page generates a new ID so a deliberate follow-up can be recorded separately.

All routes require Cloudflare Access and Worker JWT verification. Service actors are rejected. Responses are private/no-store; mutation requires a same-origin form submission. Customer text is escaped in the page.

No WhatsApp provider, credentials or automatic sending is configured. Automation can be added later as a separate outbox integration with its own delivery semantics.
