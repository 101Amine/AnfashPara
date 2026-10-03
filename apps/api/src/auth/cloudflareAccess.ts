// apps/api/src/auth/cloudflareAccess.ts
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { MiddlewareHandler } from 'hono';

export type AppBindings = Omit<ApiBindings, 'COURIER_MODE' | 'COURIER_NAME'> & {
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_STAGING_CLIENT_ID?: string;
  COURIER_ACCOUNT_ID?: string;
  COURIER_API_TOKEN?: string;
  COURIER_API_URL?: string;
  COURIER_LABEL_ORIGINS?: string;
  COURIER_MODE?: string;
  COURIER_NAME?: string;
  COURIER_WEBHOOK_SECRET?: string;
  ORDER_WEBHOOK_SECRET?: string;
};

export type AccessIdentity = {
  email: string;
  subject: string;
  kind?: 'service';
};

export type AppVariables = {
  accessIdentity: AccessIdentity;
};

export type AppEnvironment = {
  Bindings: AppBindings;
  Variables: AppVariables;
};

type AccessClaims = JWTPayload & {
  email?: unknown;
  common_name?: unknown;
};

type MiddlewareOptions = {
  getKey?: JWTVerifyGetKey;
};

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

const normalizeTeamDomain = (value: string): string => {
  const candidate = value.includes('://') ? value : `https://${value}`;
  const url = new URL(candidate);

  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.cloudflareaccess.com') ||
    url.pathname !== '/'
  ) {
    throw new Error('Invalid Cloudflare Access team domain');
  }

  return url.origin;
};

const getRemoteKeySet = (issuer: string): JWTVerifyGetKey => {
  const cached = remoteKeySets.get(issuer);
  if (cached) {
    return cached;
  }

  const keySet = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', `${issuer}/`));
  remoteKeySets.set(issuer, keySet);
  return keySet;
};

export const verifyCloudflareAccessToken = async (
  token: string,
  audience: string,
  teamDomain: string,
  getKey?: JWTVerifyGetKey,
  serviceClientId?: string,
): Promise<AccessIdentity> => {
  const issuer = normalizeTeamDomain(teamDomain);
  const { payload } = await jwtVerify<AccessClaims>(token, getKey ?? getRemoteKeySet(issuer), {
    algorithms: ['RS256'],
    audience,
    issuer,
  });

  if (payload.common_name !== undefined) {
    if (
      !serviceClientId ||
      payload.common_name !== serviceClientId ||
      payload.sub !== '' ||
      payload.type !== 'app' ||
      typeof payload.exp !== 'number' ||
      payload.email !== undefined
    )
      throw new Error('Unapproved service identity');
    return { email: 'staging-runner@service.invalid', subject: serviceClientId, kind: 'service' };
  }

  if (
    typeof payload.email !== 'string' ||
    payload.email.trim() === '' ||
    typeof payload.sub !== 'string' ||
    payload.sub.trim() === ''
  ) {
    throw new Error('Cloudflare Access identity claims are missing');
  }

  return {
    email: payload.email,
    subject: payload.sub,
  };
};

export const cloudflareAccess =
  (options: MiddlewareOptions = {}): MiddlewareHandler<AppEnvironment> =>
  async (context, next) => {
    const audience = context.env.CF_ACCESS_AUD?.trim();
    const teamDomain = context.env.CF_ACCESS_TEAM_DOMAIN?.trim();

    if (!audience || !teamDomain) {
      return context.json({ error: 'Access configuration unavailable' }, 503);
    }

    const token = context.req.header('Cf-Access-Jwt-Assertion');
    if (!token) {
      context.header('WWW-Authenticate', 'Bearer');
      return context.json({ error: 'Unauthorized' }, 401);
    }

    try {
      const identity = await verifyCloudflareAccessToken(
        token,
        audience,
        teamDomain,
        options.getKey,
        context.env.ENVIRONMENT === 'staging' &&
          new URL(context.req.url).hostname === 'para-api-staging.alanfashpara.workers.dev'
          ? context.env.CF_ACCESS_STAGING_CLIENT_ID?.trim()
          : undefined,
      );
      if (identity.kind === 'service') {
        const path = new URL(context.req.url).pathname;
        const action =
          /^\/admin\/orders\/([a-f0-9-]{36})\/(?:confirmation|parcel|shipments\/[a-f0-9-]{36}\/status)$/u.exec(
            path,
          );
        const testing =
          path === '/admin/testing/lifecycle' && ['GET', 'POST'].includes(context.req.method);
        if (!testing && !(context.req.method === 'POST' && action && context.env.DB))
          return context.json({ error: 'Forbidden' }, 403);
        if (!testing && action && context.env.DB) {
          const row = await context.env.DB.prepare(
            'SELECT order_number,utm_campaign,utm_source,address,note FROM orders WHERE id=? AND store_id=?',
          )
            .bind(action[1], 'para-main')
            .first<{
              order_number: string;
              utm_campaign: string;
              utm_source: string;
              address: string;
              note: string;
            }>();
          if (
            !row ||
            !/^STG-[a-f0-9]{32}-[1-5]$/u.test(row.order_number) ||
            row.order_number !== `STG-${row.utm_campaign}-${row.order_number.slice(-1)}` ||
            row.utm_source !== 'staging-test' ||
            row.note !== 'STAGING_LIFECYCLE' ||
            row.address !== 'Adresse test staging - ne pas livrer'
          )
            return context.json({ error: 'Forbidden' }, 403);
        }
      }
      context.set('accessIdentity', identity);
      await next();
    } catch {
      context.header('WWW-Authenticate', 'Bearer');
      return context.json({ error: 'Unauthorized' }, 401);
    }
  };
