// apps/api/src/auth/cloudflareAccess.ts
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { MiddlewareHandler } from 'hono';

export type AppBindings = ApiBindings & {
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  ORDER_WEBHOOK_SECRET?: string;
};

export type AccessIdentity = {
  email: string;
  subject: string;
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
): Promise<AccessIdentity> => {
  const issuer = normalizeTeamDomain(teamDomain);
  const { payload } = await jwtVerify<AccessClaims>(token, getKey ?? getRemoteKeySet(issuer), {
    algorithms: ['RS256'],
    audience,
    issuer,
  });

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
      );
      context.set('accessIdentity', identity);
      await next();
    } catch {
      context.header('WWW-Authenticate', 'Bearer');
      return context.json({ error: 'Unauthorized' }, 401);
    }
  };
