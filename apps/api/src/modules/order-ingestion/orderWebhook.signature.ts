// apps/api/src/modules/order-ingestion/orderWebhook.signature.ts
export const ORDER_WEBHOOK_SIGNATURE_HEADER = 'X-Para-Signature' as const;

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/u;

export async function verifyOrderWebhookSignature(
  rawPayload: string,
  signatureHeader: string | undefined,
  secret: string,
): Promise<boolean> {
  const signatureHex =
    signatureHeader === undefined ? undefined : SIGNATURE_PATTERN.exec(signatureHeader)?.[1];
  if (signatureHex === undefined) {
    return false;
  }

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
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}
