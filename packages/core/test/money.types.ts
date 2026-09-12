import { add, cents, type Cents } from '../src/money';

const brandedAmount: Cents = cents(100);
add(brandedAmount, cents(50));

// @ts-expect-error Plain numbers must not be accepted where Cents are required.
add(100, brandedAmount);
