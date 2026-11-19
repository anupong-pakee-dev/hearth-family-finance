export type Palette = { id: string; primary: string; inc: string; exp: string; heat: string; c1: string; c2: string; c3: string; c4: string; c5: string };
export const SLOTS: readonly ('primary' | 'inc' | 'exp' | 'heat' | 'c1' | 'c2' | 'c3' | 'c4' | 'c5')[];
export const PRESETS: readonly Palette[];
export function sanitize(input: unknown): Record<string, string>;
export function normalize(input: unknown): Record<string, string>;
export function mix(a: string, b: string, t: number): string;
export function contrast(a: string, b: string): number;
export function themeVars(colors: unknown, dark: boolean): Record<string, string>;
export function cssFor(colors: unknown): string;
