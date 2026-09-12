declare const moroccanMobileBrand: unique symbol;

export type MoroccanMobileE164 = `+212${'6' | '7'}${string}` & {
  readonly [moroccanMobileBrand]: 'MoroccanMobileE164';
};

const NATIONAL_MOBILE = /^0([67]\d{8})$/u;
const E164_MOBILE = /^\+212([67]\d{8})$/u;
const INTERNATIONAL_PREFIX_MOBILE = /^00212([67]\d{8})$/u;

export function normalizeMoroccanMobile(input: string): MoroccanMobileE164 {
  const compactInput = input.replace(/\s+/gu, '');
  const subscriberNumber =
    NATIONAL_MOBILE.exec(compactInput)?.[1] ??
    E164_MOBILE.exec(compactInput)?.[1] ??
    INTERNATIONAL_PREFIX_MOBILE.exec(compactInput)?.[1];

  if (subscriberNumber === undefined) {
    throw new SyntaxError('Expected a Moroccan mobile number beginning with 06 or 07.');
  }

  return `+212${subscriberNumber}` as MoroccanMobileE164;
}

export function toWaMeUrl(input: string): string {
  const mobile = normalizeMoroccanMobile(input);
  return `https://wa.me/${mobile.slice(1)}`;
}
