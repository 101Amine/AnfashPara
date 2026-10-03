// apps/api/scripts/staging-order-lifecycle.ts
import { createHmac, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { z } from 'zod';

const configurationSchema = z
  .object({
    CF_ACCESS_CLIENT_ID: z.string().trim().min(1),
    CF_ACCESS_CLIENT_SECRET: z.string().trim().min(1),
    COURIER_WEBHOOK_SECRET: z.string().min(32),
    ORDER_WEBHOOK_SECRET: z.string().min(32),
    STAGING_BASE_URL: z
      .literal('https://para-api-staging.alanfashpara.workers.dev')
      .default('https://para-api-staging.alanfashpara.workers.dev'),
    STAGING_TEST_SKU: z.string().trim().min(1).default('VITC-1000-001'),
    STAGING_EXPECTED_SHA: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .optional(),
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

let runReference: string | null = null;
async function main(): Promise<void> {
  const configuration = configurationSchema.parse(process.env);
  const baseUrl = configuration.STAGING_BASE_URL.replace(/\/$/u, '');
  const runId = randomUUID().replaceAll('-', '');
  runReference = runId;
  console.log(JSON.stringify({ run: runId, result: 'started' }));
  const preflight = await fetch(`${baseUrl}/admin/testing/lifecycle`, {
    headers: {
      'CF-Access-Client-Id': configuration.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': configuration.CF_ACCESS_CLIENT_SECRET,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  assert(preflight.status === 200, 'Preflight failed');
  const deployed = z
    .object({ environment: z.literal('staging'), mode: z.literal('manual'), gitSha: z.string() })
    .parse(await preflight.json());
  assert(
    !configuration.STAGING_EXPECTED_SHA || deployed.gitSha === configuration.STAGING_EXPECTED_SHA,
    'Staging version differs',
  );
  const cases: ReadonlyArray<{ caseName: TestCaseName; phone: string }> = [
    { caseName: 'delivered', phone: '0611111101' },
    { caseName: 'refused-returned', phone: '0611111102' },
    { caseName: 'customer-cancelled', phone: '0611111103' },
    { caseName: 'three-no-answer', phone: '0611111104' },
    { caseName: 'duplicate-replay', phone: '0611111105' },
  ];

  const orders = await Promise.all(
    cases.map(async ({ caseName }, index): Promise<CreatedOrder> => {
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
            note: 'STAGING_LIFECYCLE',
            phone: `06${String(Number.parseInt(runId.slice(0, 8), 16) % 10000000).padStart(7, '0')}${sequence}`,
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

  await runAdminActions(orders);
  const packed = await report();
  for (const order of orders.filter(
    (o) => !['customer-cancelled', 'three-no-answer'].includes(o.caseName),
  )) {
    const row = packed.orders.find((r) => r.id === order.orderId);
    assert(row?.shipmentId, 'Missing shipment');
    const response = await fetch(
      `${baseUrl}/admin/orders/${order.orderId}/shipments/${row.shipmentId}/status`,
      {
        method: 'POST',
        headers: {
          'CF-Access-Client-Id': configuration.CF_ACCESS_CLIENT_ID,
          'CF-Access-Client-Secret': configuration.CF_ACCESS_CLIENT_SECRET,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'picked' }),
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      },
    );
    assert(response.status === 200, 'Manual handover failed');
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
  const before = await report();
  const duplicateSecond = await postCourierWebhook(duplicatePayload);
  assert(
    duplicateSecond.duplicate,
    `${duplicateReplay.orderNumber}: replayed courier event was not deduplicated`,
  );
  const after = await report();
  assert(JSON.stringify(before) === JSON.stringify(after), 'Replay changed persisted counts');
  const expected = [
    ['DELIVERED', 1, 2, 1, 5],
    ['RETURNED', 1, 3, 2, 6],
    ['CANCELLED', 1, 0, 0, 2],
    ['CANCELLED', 3, 0, 0, 4],
    ['DELIVERED', 1, 2, 1, 5],
  ] as const;
  after.orders.forEach((row, n) => {
    const e = expected[n];
    assert(
      e &&
        row.id === orders[n]?.orderId &&
        row.status === e[0] &&
        row.attempts === e[1] &&
        row.shipmentEvents === e[2] &&
        row.movements === e[3] &&
        row.orderEvents === e[4],
      'Unexpected final counts',
    );
  });
  const archive = await fetch(`${baseUrl}/admin/testing/lifecycle`, {
    method: 'POST',
    headers: {
      'CF-Access-Client-Id': configuration.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': configuration.CF_ACCESS_CLIENT_SECRET,
      Origin: baseUrl,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ run: runId, action: 'archive' }),
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  assert(archive.status === 200, 'Archive failed; preserve run');
  const evidence = {
    run: runId,
    result: 'passed',
    archived: true,
    cases: after.orders.map((r, n) => ({
      case: orders[n]?.caseName,
      status: r.status,
      attempts: r.attempts,
      shipmentEvents: r.shipmentEvents,
      movements: r.movements,
      orderEvents: r.orderEvents,
    })),
  };
  await writeFile('staging-lifecycle-report.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));

  console.log('\nPASS: staging lifecycle webhooks and duplicate replay completed.');
  console.log('Verified final statuses and counts; synthetic run archived.');
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
    assert(
      clientId !== undefined && clientSecret !== undefined,
      'Access service token unavailable',
    );
    const response = await fetch(`${baseUrl}${path}`, {
      body,
      headers: {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseUrl,
      },
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
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
    assert(response.ok, `courier webhook returned HTTP ${response.status}`);
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
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
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
      createdOrders.map(({ caseName, orderId, orderNumber }) => ({
        caseName,
        orderId,
        orderNumber,
      })),
    );
  }

  async function report() {
    const response = await fetch(`${baseUrl}/admin/testing/lifecycle?run=${runId}`, {
      headers: {
        'CF-Access-Client-Id': configuration.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': configuration.CF_ACCESS_CLIENT_SECRET,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    assert(response.status === 200, 'Report failed');
    return z
      .object({
        orders: z
          .array(
            z.object({
              id: z.uuid(),
              status: z.string(),
              shipmentId: z.uuid().nullable(),
              attempts: z.number().int(),
              shipmentEvents: z.number().int(),
              movements: z.number().int(),
              shipments: z.number().int(),
              orderEvents: z.number().int(),
              customerOrders: z.number().int(),
              customerDelivered: z.number().int(),
              customerRefused: z.number().int(),
              inboxCount: z.number().int(),
            }),
          )
          .length(5),
      })
      .parse(await response.json());
  }
}
try {
  await main();
} catch {
  await writeFile(
    'staging-lifecycle-report.json',
    JSON.stringify({ run: runReference, result: 'failed', preserveEvidence: true }),
  );
  console.error(
    'Staging lifecycle failed. Preserve the started run reference; no credentials or provider response logged.',
  );
  process.exitCode = 1;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
