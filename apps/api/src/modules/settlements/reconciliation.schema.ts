// apps/api/src/modules/settlements/reconciliation.schema.ts
import { MAX_SETTLEMENT_FILE_BYTES, parse } from '@para/core';
import { z } from 'zod';

const text = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) => ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
  );
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });
export const reconciliationInputSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .refine((value) => new TextEncoder().encode(value).byteLength <= MAX_SETTLEMENT_FILE_BYTES),
    courier: text,
    statementReference: text,
    periodStart: date,
    periodEnd: date,
    amountPaid: z
      .string()
      .trim()
      .regex(/^\d{1,14}(?:[.,]\d{1,2})?$/)
      .refine((value) => {
        try {
          parse(value);
          return true;
        } catch {
          return false;
        }
      }),
  })
  .strict()
  .refine((value) => value.periodStart <= value.periodEnd);
export type ReconciliationInput = z.infer<typeof reconciliationInputSchema>;
