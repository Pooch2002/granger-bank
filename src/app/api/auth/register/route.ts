import { z } from "zod";
import { parseJsonBody, emailSchema, passwordSchema, isoCountrySchema } from "@/server/security/validation";
import { withErrorHandling, jsonOk } from "@/server/http/respond";
import { enforceRateLimit } from "@/server/security/rateLimiter";
import { getClientIp } from "@/server/auth/guards";
import { registerCustomer } from "@/server/services/userService";

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  legalFirstName: z.string().trim().min(1).max(100),
  legalLastName: z.string().trim().min(1).max(100),
  dateOfBirth: z.coerce.date(),
  country: isoCountrySchema,
  addressLine1: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(20),
});

export const POST = withErrorHandling(async (request: Request) => {
  const ip = getClientIp(request);
  await enforceRateLimit({ key: `register:ip:${ip}`, limit: 5, windowSeconds: 60 * 60, ipAddress: ip, skipIfIpUnknown: true });

  const input = await parseJsonBody(request, registerSchema);

  const minAge = new Date();
  minAge.setFullYear(minAge.getFullYear() - 18);
  if (input.dateOfBirth > minAge) {
    return jsonOk({ error: { code: "VALIDATION_ERROR", message: "You must be at least 18 years old to open an account." } }, 422);
  }

  const user = await registerCustomer(input);

  return jsonOk(
    {
      message: "Account created. Check your email to verify your address before signing in.",
      userId: user.id,
    },
    201
  );
});
