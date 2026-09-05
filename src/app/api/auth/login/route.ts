import { z } from "zod";
import { parseJsonBody, emailSchema } from "@/server/security/validation";
import { withErrorHandling, jsonOk } from "@/server/http/respond";
import { assertCsrf } from "@/server/security/csrf";
import { enforceRateLimit } from "@/server/security/rateLimiter";
import { getClientIp } from "@/server/auth/guards";
import { login } from "@/server/services/userService";

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
  rememberMe: z.boolean().optional(),
});

export const POST = withErrorHandling(async (request: Request) => {
  await assertCsrf(request);

  const ip = getClientIp(request);
  const input = await parseJsonBody(request, loginSchema);

  // Two independent limits: per-IP (blunts credential stuffing across many
  // accounts from one source) and per-account (blunts distributed attempts
  // against a single target). See
  // docs/production/04-authentication-architecture.md §5.
  await enforceRateLimit({ key: `login:ip:${ip}`, limit: 20, windowSeconds: 15 * 60, ipAddress: ip, skipIfIpUnknown: true });
  await enforceRateLimit({ key: `login:email:${input.email}`, limit: 5, windowSeconds: 15 * 60, ipAddress: ip });

  const userAgent = request.headers.get("user-agent") ?? "unknown";
  const result = await login({
    email: input.email,
    password: input.password,
    ipAddress: ip,
    userAgent,
    rememberMe: input.rememberMe,
  });

  if (result.outcome === "invalid_credentials") {
    return jsonOk({ error: { code: "INVALID_CREDENTIALS", message: "Incorrect email or password." } }, 401);
  }
  if (result.outcome === "locked") {
    return jsonOk(
      {
        error: {
          code: "ACCOUNT_LOCKED",
          message: `Too many failed attempts. Try again after ${result.lockedUntil.toISOString()}.`,
        },
      },
      423
    );
  }

  return jsonOk({ mfaRequired: result.mfaRequired });
});
