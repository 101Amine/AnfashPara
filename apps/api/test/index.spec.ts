import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('API routes', () => {
  it('reports a healthy local deployment', async () => {
    const response = await SELF.fetch('https://example.com/api/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      environment: 'local',
      status: 'ok',
    });
  });

  it('reports the configured git SHA', async () => {
    const response = await SELF.fetch('https://example.com/api/version');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ gitSha: 'uncommitted' });
  });

  it('adds basic security and cache headers', async () => {
    const response = await SELF.fetch('https://example.com/api/health');

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('returns JSON for unknown routes', async () => {
    const response = await SELF.fetch('https://example.com/missing');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
  });
});

describe('scheduled handler', () => {
  it('logs cron execution metadata', async () => {
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
        cron: '0 * * * *',
        environment: 'local',
        event: 'scheduled',
        gitSha: 'uncommitted',
        scheduledTime: '2026-09-12T12:00:00.000Z',
      }),
    );
  });
});
