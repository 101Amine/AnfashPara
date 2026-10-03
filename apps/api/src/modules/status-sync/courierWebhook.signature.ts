// apps/api/src/modules/status-sync/courierWebhook.signature.ts
export const COURIER_WEBHOOK_SIGNATURE_HEADER = 'X-Courier-Signature' as const;

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/u;

export async function verifyCourierWebhookSignature(
  rawPayload: string,
  signatureHeader: string | undefined,
  secret: string,
): Promise<boolean> {
  const signatureHex =
    signatureHeader === undefined ? undefined : SIGNATURE_PATTERN.exec(signatureHeader)?.[1];
  if (signatureHex === undefined) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify('HMAC', key, hexToBytes(signatureHex), encoder.encode(rawPayload));
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}
