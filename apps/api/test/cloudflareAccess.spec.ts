// apps/api/test/cloudflareAccess.spec.ts
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { cloudflareAccess, type AppBindings } from '../src/auth/cloudflareAccess';
import { createApp } from '../src/index';
import { env } from 'cloudflare:test';

const AUDIENCE = 'test-audience';
const ISSUER = 'https://test.cloudflareaccess.com';
const EMAIL = 'admin@example.com';
const SUBJECT = 'access-user-id';
const KEY_ID = 'test-key';

let privateKey: CryptoKey;
let localKeySet: JWTVerifyGetKey;

const bindings: AppBindings = {
  CF_ACCESS_AUD: AUDIENCE,
  CF_ACCESS_TEAM_DOMAIN: ISSUER,
  ENVIRONMENT: 'local',
  GIT_SHA: 'uncommitted',
};

const signToken = async (
  overrides: {
    audience?: string;
    email?: string;
    expirationTime?: number;
    issuer?: string;
    subject?: string;
  } = {},
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({ email: overrides.email ?? EMAIL })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(overrides.subject ?? SUBJECT)
    .setIssuedAt(now)
    .setExpirationTime(overrides.expirationTime ?? now + 300)
    .sign(privateKey);
};

const requestWhoAmI = async (
  token?: string,
  environment: AppBindings = bindings,
): Promise<Response> => {
  const app = createApp(cloudflareAccess({ getKey: localKeySet }));
  const headers = token ? { 'Cf-Access-Jwt-Assertion': token } : undefined;

  return app.request('https://example.com/admin/whoami', { headers }, environment);
};

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  const jwks: JSONWebKeySet = {
    keys: [{ ...publicJwk, alg: 'RS256', kid: KEY_ID, use: 'sig' }],
  };
  localKeySet = createLocalJWKSet(jwks);
});

describe('Cloudflare Access middleware', () => {
  async function machineToken(
    commonName = 'test.access',
    expiry = Math.floor(Date.now() / 1000) + 300,
  ) {
    return new SignJWT({ common_name: commonName, type: 'app' })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('')
      .setExpirationTime(expiry)
      .sign(privateKey);
  }
  const machineBindings = () => ({
    ...env,
    ...bindings,
    ENVIRONMENT: 'staging',
    CF_ACCESS_STAGING_CLIENT_ID: 'test.access',
  });
  const staging = 'https://para-api-staging.alanfashpara.workers.dev';
  it('accepts the configured signed service identity for staging preflight only', async () => {
    const response = await createApp(cloudflareAccess({ getKey: localKeySet })).request(
      staging + '/admin/testing/lifecycle',
      { headers: { 'Cf-Access-Jwt-Assertion': await machineToken() } },
      machineBindings(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ environment: 'staging', mode: 'manual' });
  });
  it('rejects unapproved and expired service identities', async () => {
    for (const token of [
      await machineToken('other.access'),
      await machineToken('test.access', 1),
    ]) {
      expect(
        (
          await createApp(cloudflareAccess({ getKey: localKeySet })).request(
            staging + '/admin/testing/lifecycle',
            { headers: { 'Cf-Access-Jwt-Assertion': token } },
            machineBindings(),
          )
        ).status,
      ).toBe(401);
    }
  });
  it('does not accept service authentication on production or a different host', async () => {
    const app = createApp(cloudflareAccess({ getKey: localKeySet }));
    const token = await machineToken();
    expect(
      (
        await app.request(
          staging + '/admin/testing/lifecycle',
          { headers: { 'Cf-Access-Jwt-Assertion': token } },
          { ...machineBindings(), ENVIRONMENT: 'prod' },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          'https://example.com/admin/testing/lifecycle',
          { headers: { 'Cf-Access-Jwt-Assertion': token } },
          machineBindings(),
        )
      ).status,
    ).toBe(401);
  });
  it('denies general admin access even with an approved service JWT', async () => {
    for (const path of ['/admin/orders', '/admin/inventory', '/admin/dashboard', '/admin/whoami'])
      expect(
        (
          await createApp(cloudflareAccess({ getKey: localKeySet })).request(
            staging + path,
            { headers: { 'Cf-Access-Jwt-Assertion': await machineToken() } },
            machineBindings(),
          )
        ).status,
      ).toBe(403);
  });
  it('rejects non-synthetic order writes before entering the domain route', async () => {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS orders(id TEXT,store_id TEXT,order_number TEXT,utm_campaign TEXT,utm_source TEXT,address TEXT,note TEXT)',
    ).run();
    const id = '0199b001-1000-7000-8000-000000000001';
    await env.DB.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?)')
      .bind(id, 'para-main', 'REAL-1', 'real', 'web', 'real', 'real')
      .run();
    const response = await createApp(cloudflareAccess({ getKey: localKeySet })).request(
      staging + `/admin/orders/${id}/confirmation`,
      { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': await machineToken() } },
      machineBindings(),
    );
    expect(response.status).toBe(403);
  });
  it('returns the verified email for a valid Access token', async () => {
    const response = await requestWhoAmI(await signToken());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ email: EMAIL });
  });

  it('rejects a request without an Access token', async () => {
    const response = await requestWhoAmI();

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects a malformed token without exposing verification details', async () => {
    const response = await requestWhoAmI('not-a-jwt');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects a token with a tampered signature', async () => {
    const token = await signToken();
    const [header, payload, signature] = token.split('.');
    const replacement = signature.startsWith('a') ? 'b' : 'a';
    const tamperedToken = `${header}.${payload}.${replacement}${signature.slice(1)}`;

    const response = await requestWhoAmI(tamperedToken);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects an expired token', async () => {
    const response = await requestWhoAmI(
      await signToken({ expirationTime: Math.floor(Date.now() / 1000) - 60 }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects a token issued for a different application', async () => {
    const response = await requestWhoAmI(await signToken({ audience: 'different-audience' }));

    expect(response.status).toBe(401);
  });

  it('rejects a token from a different issuer', async () => {
    const response = await requestWhoAmI(
      await signToken({ issuer: 'https://other.cloudflareaccess.com' }),
    );

    expect(response.status).toBe(401);
  });

  it('rejects a verified token without an email claim', async () => {
    const response = await requestWhoAmI(await signToken({ email: '' }));

    expect(response.status).toBe(401);
  });

  it('returns a service error when Access configuration is missing', async () => {
    const response = await requestWhoAmI(await signToken(), {
      ENVIRONMENT: 'local',
      GIT_SHA: 'uncommitted',
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Access configuration unavailable',
    });
  });

  it('accepts a team domain without an explicit scheme', async () => {
    const response = await requestWhoAmI(await signToken(), {
      ...bindings,
      CF_ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
    });

    expect(response.status).toBe(200);
  });
});
