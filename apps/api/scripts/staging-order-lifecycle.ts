// apps/api/scripts/staging-order-lifecycle.ts
import { createHmac } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

import { z } from 'zod';

const configurationSchema = z
  .object({
    CF_ACCESS_CLIENT_ID: z.string().trim().min(1).optional(),
    CF_ACCESS_CLIENT_SECRET: z.string().trim().min(1).optional(),
    COURIER_WEBHOOK_SECRET: z.string().min(32),
    ORDER_WEBHOOK_SECRET: z.string().min(32),
    STAGING_BASE_URL: z.url().default('https://para-api-staging.alanfashpara.workers.dev'),
    STAGING_TEST_SKU: z.string().trim().min(1).default('VITC-1000-001'),
  })
  .superRefine((configuration, context) => {
    const hasClientId = configuration.CF_ACCESS_CLIENT_ID !== undefined;
    const hasClientSecret = configuration.CF_ACCESS_CLIENT_SECRET !== undefined;
    if (hasClientId !== hasClientSecret) {
      context.addIssue({
        code: 'custom',
        message: 'CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be provided together',
      });
    }
  });

type TestCaseName =
  'customer-cancelled' | 'delivered' | 'duplicate-replay' | 'refused-returned' | 'three-no-answer';

type CreatedOrder = {
  caseName: TestCaseName;
  eventId: string;
  orderId: string;
  orderNumber: string;
};

type OrderIngestionResponse =
  { duplicate: true } | { duplicate: false; orderId: string; status: 'CONFIRMING' };

type CourierWebhookResponse = {
  duplicate: boolean;
  orderStatus?: string;
};

const configuration = configurationSchema.parse(process.env);
const baseUrl = configuration.STAGING_BASE_URL.replace(/\/$/u, '');
const runId = new Date()
  .toISOString()
  .replaceAll(/[-:.TZ]/gu, '')
  .slice(0, 14);
const cases: ReadonlyArray<{ caseName: TestCaseName; phone: string }> = [
  { caseName: 'delivered', phone: '0611111101' },
  { caseName: 'refused-returned', phone: '0611111102' },
  { caseName: 'customer-cancelled', phone: '0611111103' },
  { caseName: 'three-no-answer', phone: '0611111104' },
  { caseName: 'duplicate-replay', phone: '0611111105' },
];

const orders = await Promise.all(
  cases.map(async ({ caseName, phone }, index): Promise<CreatedOrder> => {
    const sequence = index + 1;
    const eventId = `stg-order-${runId}-${sequence}`;
    const orderNumber = `STG-${runId}-${sequence}`;
    const payload = JSON.stringify({
      eventId,
      order: {
        attribution: {
          utmCampaign: runId,
          utmContent: caseName,
          utmSource: 'staging-test',
        },
        customer: {
          address: 'Adresse test staging - ne pas livrer',
          city: 'Casablanca',
          name: `Test Staging ${caseName}`,
          phone,
        },
        externalId: `stg-ext-${runId}-${sequence}`,
        items: [{ quantity: 1, sku: configuration.STAGING_TEST_SKU }],
        orderNumber,
        placedAt: new Date().toISOString(),
        shippingFeeCustomerCentimes: 0,
      },
    });
    const response = await signedPost(
      '/api/webhooks/orders',
      'X-Para-Signature',
      configuration.ORDER_WEBHOOK_SECRET,
      payload,
    );
    const result = await readJson<OrderIngestionResponse>(response);
    assert(response.status === 201, `${orderNumber}: ingestion returned HTTP ${response.status}`);
    assert(!result.duplicate, `${orderNumber}: fresh event was reported as duplicate`);
    assert(result.status === 'CONFIRMING', `${orderNumber}: expected CONFIRMING after ingestion`);
    return { caseName, eventId, orderId: result.orderId, orderNumber };
  }),
);

printOrders('Created five staging orders', orders);

const automatedAdmin = configuration.CF_ACCESS_CLIENT_ID !== undefined;
if (automatedAdmin) {
  await runAdminActions(orders);
} else {
  console.log('\nComplete these actions in the protected staging admin queue:');
  console.log('- delivered, refused-returned, duplicate-replay: Confirmé, then Créer le colis');
  console.log('- customer-cancelled: Annulé');
  console.log('- three-no-answer: Pas de réponse three times');
  await waitForEnter();
}

const delivered = findOrder(orders, 'delivered');
const refusedReturned = findOrder(orders, 'refused-returned');
const duplicateReplay = findOrder(orders, 'duplicate-replay');

await expectCourierStatus(delivered, 'delivered', 'DELIVERED');
await expectCourierStatus(refusedReturned, 'refused', 'REFUSED');
await expectCourierStatus(refusedReturned, 'returned', 'RETURNED');

const duplicatePayload = courierPayload(duplicateReplay, 'delivered');
const duplicateFirst = await postCourierWebhook(duplicatePayload);
assert(
  duplicateFirst.orderStatus === 'DELIVERED' && !duplicateFirst.duplicate,
  `${duplicateReplay.orderNumber}: first webhook did not deliver the order`,
);
const duplicateSecond = await postCourierWebhook(duplicatePayload);
assert(
  duplicateSecond.duplicate,
  `${duplicateReplay.orderNumber}: replayed courier event was not deduplicated`,
);

console.log('\nPASS: staging lifecycle webhooks and duplicate replay completed.');
console.log('Verify final D1 statuses: DELIVERED, RETURNED, CANCELLED, CANCELLED, DELIVERED.');
printOrders('Run manifest', orders);

async function runAdminActions(createdOrders: CreatedOrder[]): Promise<void> {
  for (const order of createdOrders) {
    if (order.caseName === 'customer-cancelled') {
      await postConfirmation(order, 'cancelled');
      continue;
    }
    if (order.caseName === 'three-no-answer') {
      await postConfirmation(order, 'no_answer');
      await postConfirmation(order, 'no_answer');
      await postConfirmation(order, 'no_answer');
      continue;
    }
    await postConfirmation(order, 'confirmed');
    await postAdmin(`/admin/orders/${order.orderId}/parcel`, new URLSearchParams());
  }
}

async function postConfirmation(
  order: CreatedOrder,
  action: 'cancelled' | 'confirmed' | 'no_answer',
): Promise<void> {
  await postAdmin(
    `/admin/orders/${order.orderId}/confirmation`,
    new URLSearchParams({ action, channel: 'call' }),
  );
}

async function postAdmin(path: string, body: URLSearchParams): Promise<void> {
  const clientId = configuration.CF_ACCESS_CLIENT_ID;
  const clientSecret = configuration.CF_ACCESS_CLIENT_SECRET;
  assert(clientId !== undefined && clientSecret !== undefined, 'Access service token unavailable');
  const response = await fetch(`${baseUrl}${path}`, {
    body,
    headers: {
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
    redirect: 'manual',
  });
  assert(response.status === 303, `${path}: protected action returned HTTP ${response.status}`);
}

async function expectCourierStatus(
  order: CreatedOrder,
  status: 'delivered' | 'refused' | 'returned',
  expectedOrderStatus: string,
): Promise<void> {
  const result = await postCourierWebhook(courierPayload(order, status));
  assert(
    !result.duplicate,
    `${order.orderNumber}: fresh ${status} event was reported as duplicate`,
  );
  assert(
    result.orderStatus === expectedOrderStatus,
    `${order.orderNumber}: expected ${expectedOrderStatus}, received ${String(result.orderStatus)}`,
  );
}

function courierPayload(order: CreatedOrder, status: string): string {
  return JSON.stringify({
    eventId: `stg-courier-${runId}-${order.caseName}-${status}`,
    occurredAt: new Date().toISOString(),
    status: status.toUpperCase(),
    trackingNumber: manualTrackingNumber(order),
  });
}

async function postCourierWebhook(payload: string): Promise<CourierWebhookResponse> {
  const response = await signedPost(
    '/api/webhooks/courier',
    'X-Courier-Signature',
    configuration.COURIER_WEBHOOK_SECRET,
    payload,
  );
  const result = await readJson<CourierWebhookResponse>(response);
  assert(
    response.ok,
    `courier webhook returned HTTP ${response.status}: ${JSON.stringify(result)}`,
  );
  return result;
}

async function signedPost(
  path: string,
  headerName: string,
  secret: string,
  payload: string,
): Promise<Response> {
  const signature = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, {
      body: payload,
      headers: { 'Content-Type': 'application/json', [headerName]: `sha256=${signature}` },
      method: 'POST',
    });
    if (response.status !== 401 || attempt === 6) return response;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Unreachable signature retry state');
}

async function readJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  return body as T;
}

function manualTrackingNumber(order: CreatedOrder): string {
  const reference = order.orderNumber
    .normalize('NFKD')
    .replaceAll(/[^a-zA-Z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .toUpperCase()
    .slice(0, 24);
  const suffix = order.orderId.replaceAll('-', '').slice(-8).toUpperCase();
  return `SELF-${reference}-${suffix}`;
}

function findOrder(createdOrders: CreatedOrder[], caseName: TestCaseName): CreatedOrder {
  const order = createdOrders.find((candidate) => candidate.caseName === caseName);
  assert(order !== undefined, `Missing ${caseName} order`);
  return order;
}

function printOrders(title: string, createdOrders: CreatedOrder[]): void {
  console.log(`\n${title}:`);
  console.table(
    createdOrders.map(({ caseName, orderId, orderNumber }) => ({ caseName, orderId, orderNumber })),
  );
}

async function waitForEnter(): Promise<void> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await input.question('\nPress Enter when the admin actions are complete...');
  } finally {
    input.close();
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
