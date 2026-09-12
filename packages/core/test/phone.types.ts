import { normalizeMoroccanMobile, type MoroccanMobileE164 } from '../src/phone';

const mobile: MoroccanMobileE164 = normalizeMoroccanMobile('0612345678');

// @ts-expect-error Unvalidated strings must not be treated as normalized mobile numbers.
const unvalidatedMobile: MoroccanMobileE164 = '+212612345678';

void mobile;
void unvalidatedMobile;
