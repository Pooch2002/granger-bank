import { z } from "zod";
import { parseJsonBody, passwordSchema } from "@/server/security/validation";
import { withErrorHandling, jsonOk } from "@/server/http/respond";
import { assertCsrf } from "@/server/security/csrf";
import { enforceRateLimit } from "@/server/security/rateLimiter";
import { getClientIp } from "@/server/auth/guards";
import { resetPassword } from "@/server/services/userService";

const schema = z.object({ token: z.string().min(10), newPassword: passwordSchema });

export const POST = withErrorHandling(async (request: Request) => {
  await assertCsrf(request);
  const ip = getClientIp(request);
  await enforceRateLimit({ key: `pwreset-confirm:ip:${ip}`, limit: 10, windowSeconds: 60 * 60, ipAddress: ip, skipIfIpUnknown: true });

  const { token, newPassword } = await parseJsonBody(request, schema);
  await resetPassword(token, newPassword);

  return jsonOk({ message: "Password updated. You can now sign in with your new password." });
});
