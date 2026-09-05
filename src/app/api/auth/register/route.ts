import { z } from "zod";
import { parseJsonBody, emailSchema, passwordSchema } from "@/server/security/validation";
import { withErrorHandling, jsonOk } from "@/server/http/respond";
import { enforceRateLimit } from "@/server/security/rateLimiter";
import { getClientIp } from "@/server/auth/guards";
import { registerCustomer } from "@/server/services/userService";

// Date of birth, address and other KYC-relevant fields are deliberately not
// collected here — they belong to identity verification (see
// src/server/services/kycService.ts), which requires a real KYC provider
// this environment doesn't have. Collecting them at registration only to
// sit unused (and to trip an age check we can't actually act on without a
// provider) added friction for no benefit while KYC is unimplemented.
const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  legalFirstName: z.string().trim().min(1).max(100),
  legalLastName: z.string().trim().min(1).max(100),
});

export const POST = withErrorHandling(async (request: Request) => {
  const ip = getClientIp(request);
  await enforceRateLimit({ key: `register:ip:${ip}`, limit: 5, windowSeconds: 60 * 60, ipAddress: ip, skipIfIpUnknown: true });

  const input = await parseJsonBody(request, registerSchema);
  const user = await registerCustomer(input);

  return jsonOk(
    {
      message: "Account created. Check your email to verify your address before signing in.",
      userId: user.id,
    },
    201
  );
});
