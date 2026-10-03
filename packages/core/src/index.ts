export * from './courier';
export * from './money';
export * from './orderStateMachine';
export * from './phone';
export * from './settlementParser';

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
