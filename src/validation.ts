import { z } from "zod";

/** Numeric legacy inputs remain numeric; string IDs keep full 64-bit precision. */
export const numericId = z.coerce.number().int().positive();
export const stringId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((v) => /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n, "ID exceeds BIGINT range");
export const gearId = z.string().regex(/^[bg][1-9]\d{0,18}$/);
export const isoDateTime = z.iso.datetime({ offset: true, local: true });
export const isoDate = z.iso.date();
export const dateOrTime = z.union([isoDate, isoDateTime]);
export const lookbackDays = z
  .string()
  .regex(/^[1-9]\d{0,2}$/)
  .refine((v) => Number(v) <= 365, "days must be 1-365");

export function orderedWindow(start?: string | number, end?: string | number): void {
  if (start === undefined || end === undefined) return;
  const time = (v: string | number) => (typeof v === "number" ? v : Date.parse(v));
  if (time(start) >= time(end)) throw new Error("Window start must be before its end.");
}
