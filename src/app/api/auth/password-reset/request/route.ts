import { z } from "zod";
import { parseJsonBody, emailSchema } from "@/server/security/validation";
import { withErrorHandling, jsonOk } from "@/server/http/respond";
import { assertCsrf } from "@/server/security/csrf";
import { enforceRateLimit } from "@/server/security/rateLimiter";
import { getClientIp } from "@/server/auth/guards";
import { requestPasswordReset } from "@/server/services/userService";

const schema = z.object({ email: emailSchema });

export const POST = withErrorHandling(async (request: Request) => {
  await assertCsrf(request);
  const ip = getClientIp(request);
  await enforceRateLimit({ key: `pwreset:ip:${ip}`, limit: 5, windowSeconds: 60 * 60, ipAddress: ip, skipIfIpUnknown: true });

  const { email } = await parseJsonBody(request, schema);
  await requestPasswordReset(email);

  // Same response whether or not the account exists — see
  // docs/production/04-authentication-architecture.md §8.
  return jsonOk({ message: "If an account exists for that email, we've sent a reset link." });
});
