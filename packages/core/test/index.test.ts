import { describe, expect, it } from 'vitest';

import { isNonEmptyString } from '../src/index';

describe('isNonEmptyString', () => {
  it('accepts non-empty strings and rejects other values', () => {
    expect(isNonEmptyString('para')).toBe(true);
    expect(isNonEmptyString('   ')).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
  });
});
