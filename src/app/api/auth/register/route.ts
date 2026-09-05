import { z } from "zod";
import { parseJsonBody, emailSchema, passwordSchema } from "@/server/security/validation";
import { withErrorHandling, jsonOk } from "@/server/http/respond";
import { enforceRateLimit } from "@/server/security/rateLimiter";
import { getClientIp } from "@/server/auth/guards";
import { registerCustomer } from "@/server/services/userService";

// Registration only collects email/password. Name, date of birth, address
// and other KYC-relevant fields are deliberately not collected here — they
// belong to identity verification (see src/server/services/kycService.ts),
// which requires a real KYC provider this environment doesn't have.
// registerCustomer derives a placeholder name from the email so existing
// name-displaying UI keeps working; an admin can correct it later.
const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
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
