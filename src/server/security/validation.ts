import "server-only";
import { z, ZodError, type ZodType } from "zod";
import { ValidationError } from "./errors";

/**
 * Every route handler validates its input through this — never trusts
 * `await request.json()` directly. Unknown keys are stripped (zod's default
 * for object schemas without .strict()), types/ranges are enforced at
 * runtime (TypeScript types don't exist after compilation).
 */
export async function parseJsonBody<T extends ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError("The submitted data is invalid.", formatZodError(result.error));
  }
  return result.data;
}

export function parseSearchParams<T extends ZodType>(url: URL, schema: T): z.infer<T> {
  const obj = Object.fromEntries(url.searchParams.entries());
  const result = schema.safeParse(obj);
  if (!result.success) {
    throw new ValidationError("Invalid query parameters.", formatZodError(result.error));
  }
  return result.data;
}

/** One message per field (first issue wins if a field has multiple), keyed
 * by dotted path — e.g. `{ dateOfBirth: "Invalid date" }`. Issues with no
 * path (whole-object refinements) are keyed under "_root". */
function formatZodError(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_root";
    if (!(path in fields)) fields[path] = issue.message;
  }
  return fields;
}

// Shared primitive schemas -----------------------------------------------

/** Amounts are always transmitted/stored as integer minor units (cents). */
export const amountMinorSchema = z
  .number()
  .int("Amount must be an integer number of minor units (cents).")
  .positive("Amount must be greater than zero.")
  .max(1_000_000_000, "Amount exceeds the maximum allowed.");

export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO 4217 code.");

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters.")
  .max(256)
  .refine((pw) => /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw), {
    message: "Password must include upper case, lower case, and a number.",
  });

export const uuidSchema = z.string().uuid();

export const isoCountrySchema = z.string().length(2).regex(/^[A-Z]{2}$/, "Country must be a 2-letter ISO code.");
