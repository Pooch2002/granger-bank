import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "../db";
import { hashPassword, verifyPassword, isObviouslyWeakPassword } from "../auth/passwords";
import { createSession, revokeAllSessionsForUser } from "../auth/session";
import { sha256Hex } from "../security/encryption";
import { recordSecurityEvent } from "../security/audit";
import { getEmailProvider } from "../providers/registry";
import { ConflictError, ValidationError } from "../security/errors";
import { getEnv } from "../env";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const EMAIL_TOKEN_TTL_HOURS = 24;
const RESET_TOKEN_TTL_MINUTES = 30;

export type RegisterInput = {
  email: string;
  password: string;
  legalFirstName: string;
  legalLastName: string;
};

export async function registerCustomer(input: RegisterInput) {
  const weakness = isObviouslyWeakPassword(input.password, { email: input.email });
  if (weakness) throw new ValidationError(weakness);

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    // Do not reveal whether the account exists via a different error shape —
    // still a 409 here (registration is not a login attempt, so account
    // enumeration risk is lower, but message stays generic).
    throw new ConflictError("An account with this email already exists.");
  }

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        status: "PENDING_VERIFICATION",
        customerProfile: {
          create: {
            legalFirstName: input.legalFirstName,
            legalLastName: input.legalLastName,
            kyc: { create: { status: "NOT_STARTED" } },
          },
        },
      },
    });
    return created;
  });

  await sendEmailVerification(user.id, user.email);

  return user;
}

async function sendEmailVerification(userId: string, email: string) {
  const rawToken = randomBytes(32).toString("base64url");
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_HOURS * 60 * 60 * 1000),
    },
  });

  const env = getEnv();
  const verifyUrl = `${env.APP_URL}/verify-email?token=${rawToken}`;
  await getEmailProvider().send({
    to: email,
    subject: "Verify your Granger Bank email address",
    text: `Welcome to Granger Bank. Verify your email address: ${verifyUrl}\n\nThis link expires in ${EMAIL_TOKEN_TTL_HOURS} hours.`,
  });
}

export async function verifyEmail(rawToken: string) {
  const tokenHash = sha256Hex(rawToken);
  const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash } });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new ValidationError("This verification link is invalid or has expired.");
  }

  await prisma.$transaction([
    prisma.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
  ]);
}

export type LoginResult =
  | { outcome: "success"; userId: string; mfaRequired: boolean }
  | { outcome: "invalid_credentials" }
  | { outcome: "locked"; lockedUntil: Date };

export async function login(params: {
  email: string;
  password: string;
  ipAddress: string;
  userAgent: string;
  rememberMe?: boolean;
}): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { email: params.email } });

  if (!user) {
    // Constant-shape failure path — no signal to the caller about whether
    // the email exists (mitigates user enumeration).
    await recordSecurityEvent({ type: "LOGIN_FAILURE", ipAddress: params.ipAddress, metadata: { reason: "no_such_user" } });
    return { outcome: "invalid_credentials" };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordSecurityEvent({ userId: user.id, type: "LOGIN_FAILURE", ipAddress: params.ipAddress, metadata: { reason: "locked" } });
    return { outcome: "locked", lockedUntil: user.lockedUntil };
  }

  const validPassword = await verifyPassword(user.passwordHash, params.password);
  if (!validPassword) {
    const failedLoginCount = user.failedLoginCount + 1;
    const lock = failedLoginCount >= MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null,
      },
    });
    await recordSecurityEvent({
      userId: user.id,
      type: lock ? "ACCOUNT_LOCKED" : "LOGIN_FAILURE",
      ipAddress: params.ipAddress,
      metadata: { failedLoginCount },
    });
    return { outcome: "invalid_credentials" };
  }

  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });

  const { isNewDevice } = await createSession({
    userId: user.id,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    rememberMe: params.rememberMe,
  });

  await recordSecurityEvent({ userId: user.id, type: "LOGIN_SUCCESS", ipAddress: params.ipAddress });
  if (isNewDevice) {
    await recordSecurityEvent({ userId: user.id, type: "LOGIN_NEW_DEVICE", ipAddress: params.ipAddress });
    await notifyNewDeviceLogin(user.id, user.email, params.ipAddress);
  }

  return { outcome: "success", userId: user.id, mfaRequired: user.mfaEnabled };
}

async function notifyNewDeviceLogin(userId: string, email: string, ipAddress: string) {
  await prisma.notification.create({
    data: {
      userId,
      type: "security.new_device_login",
      title: "New sign-in to your account",
      body: `We noticed a sign-in from a new device (IP ${ipAddress}). If this wasn't you, secure your account immediately.`,
    },
  });
  await getEmailProvider()
    .send({
      to: email,
      subject: "New sign-in to your Granger Bank account",
      text: `We noticed a sign-in from a new device (IP ${ipAddress}). If this wasn't you, reset your password immediately.`,
    })
    .catch(() => {
      /* email delivery failures never block the login flow itself */
    });
}

export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  // Always behaves the same way externally, whether or not the user exists.
  if (!user) return;

  const rawToken = randomBytes(32).toString("base64url");
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
    },
  });

  await recordSecurityEvent({ userId: user.id, type: "PASSWORD_RESET_REQUESTED", ipAddress: "n/a" });

  const env = getEnv();
  const resetUrl = `${env.APP_URL}/reset-password?token=${rawToken}`;
  await getEmailProvider().send({
    to: user.email,
    subject: "Reset your Granger Bank password",
    text: `Reset your password: ${resetUrl}\n\nThis link expires in ${RESET_TOKEN_TTL_MINUTES} minutes. If you didn't request this, you can ignore this email.`,
  });
}

export async function resetPassword(rawToken: string, newPassword: string) {
  const tokenHash = sha256Hex(rawToken);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new ValidationError("This reset link is invalid or has expired.");
  }

  const weakness = isObviouslyWeakPassword(newPassword, {});
  if (weakness) throw new ValidationError(weakness);

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash, passwordUpdatedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    }),
  ]);

  await revokeAllSessionsForUser(record.userId, "password_reset");
  await recordSecurityEvent({ userId: record.userId, type: "PASSWORD_RESET_COMPLETED", ipAddress: "n/a" });
}

export async function changePassword(params: { userId: string; currentPassword: string; newPassword: string; currentSessionId: string }) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: params.userId } });

  const valid = await verifyPassword(user.passwordHash, params.currentPassword);
  if (!valid) throw new ValidationError("Current password is incorrect.");

  const weakness = isObviouslyWeakPassword(params.newPassword, { email: user.email });
  if (weakness) throw new ValidationError(weakness);

  const passwordHash = await hashPassword(params.newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash, passwordUpdatedAt: new Date() } });

  // Keep the session that just made this change; revoke every other one.
  await revokeAllSessionsForUser(user.id, "password_changed", params.currentSessionId);
  await recordSecurityEvent({ userId: user.id, type: "PASSWORD_CHANGED", ipAddress: "n/a" });
}
