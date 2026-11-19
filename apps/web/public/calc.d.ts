export class CalcError extends Error {
  constructor(code: string, detail?: string);
  code: string;
  detail: string;
}
export const FUNCTION_GROUPS: readonly [string, readonly [string, string, string][]][];
export function tidy(n: number): number;
export function evaluate(src: string, env?: Record<string, number>): { value: number; name?: string };
export function isExpression(s: string): boolean;
export function formatNumber(n: number, max?: number): string;
