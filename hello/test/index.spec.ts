import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTTP routes', () => {
  it('returns Worker information from the root route', async () => {
    const request = new IncomingRequest('http://example.com');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);

    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      app: 'para-hello',
      message: 'Hello Cloudflare Workers!',
    });
  });

  it('accepts a valid scratch request', async () => {
    const response = await SELF.fetch('https://example.com/scratch', {
      body: JSON.stringify({ message: 'Learn the fundamentals' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      app: 'para-hello',
      message: 'Learn the fundamentals',
    });
  });

  it('rejects an invalid scratch request', async () => {
    const response = await SELF.fetch('https://example.com/scratch', {
      body: JSON.stringify({ message: '' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
  });
});

describe('scheduled handler', () => {
  it('processes a cron event', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const controller = createScheduledController({
      cron: '0 * * * *',
      scheduledTime: Date.UTC(2026, 8, 12, 12),
    });
    const ctx = createExecutionContext();

    worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        app: 'para-hello',
        cron: '0 * * * *',
        event: 'scheduled',
        scheduledTime: '2026-09-12T12:00:00.000Z',
      }),
    );
  });
});
