import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { grantScopes, revokeScopes } from "../auth/rbac";
import { writeAuditLog } from "../security/audit";
import { ConflictError, NotFoundError, ValidationError } from "../security/errors";
import type { AdminScope, KycStatus, UserRole, UserStatus } from "@prisma/client";

/**
 * Admin-facing operations. Every mutating function here writes an
 * AuditLog row — see docs/production/07-security-architecture.md §8
 * ("every sensitive administrative action must create an audit record").
 */

export async function listCustomers(params: { search?: string; limit?: number }) {
  return prisma.customerProfile.findMany({
    where: params.search
      ? {
          OR: [
            { legalFirstName: { contains: params.search, mode: "insensitive" } },
            { legalLastName: { contains: params.search, mode: "insensitive" } },
            { user: { email: { contains: params.search, mode: "insensitive" } } },
          ],
        }
      : undefined,
    include: { user: { select: { email: true, status: true, createdAt: true } }, kyc: true },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 100,
  });
}

export async function getCustomerDetail(customerProfileId: string) {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    include: {
      user: { select: { id: true, email: true, status: true, mfaEnabled: true, createdAt: true } },
      kyc: true,
      accounts: true,
      // Recent transactions across all of this customer's accounts, so the
      // admin detail page can show a manual credit's effect (new Transaction
      // row + updated account balance) immediately after applying it.
      transactions: {
        orderBy: { initiatedAt: "desc" },
        take: 25,
        include: { sourceAccount: true, destinationAccount: true },
      },
    },
  });
  if (!profile) throw new NotFoundError("Customer not found.");
  return profile;
}

/** Edits customer-level fields an admin can correct or manage: legal name,
 * email, KYC status, and account standing (User.status — ACTIVE/SUSPENDED/
 * etc., not to be confused with an individual bank Account's status).
 * Writes one AuditLog entry capturing exactly which fields changed, from
 * what to what — never a silent update. Fields the caller omits are left
 * untouched; fields that are present but unchanged are skipped from both
 * the write and the audit metadata, so the log only ever reflects real
 * changes. */
export async function updateCustomerDetails(params: {
  customerProfileId: string;
  legalFirstName?: string;
  legalLastName?: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  kycStatus?: KycStatus;
  userStatus?: UserStatus;
  actorUserId: string;
  actorRole: UserRole;
}) {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: params.customerProfileId },
    include: { user: true, kyc: true },
  });
  if (!profile) throw new NotFoundError("Customer not found.");

  const changes: Record<string, { from: string; to: string }> = {};
  if (params.legalFirstName !== undefined && params.legalFirstName !== profile.legalFirstName) {
    changes.legalFirstName = { from: profile.legalFirstName, to: params.legalFirstName };
  }
  if (params.legalLastName !== undefined && params.legalLastName !== profile.legalLastName) {
    changes.legalLastName = { from: profile.legalLastName, to: params.legalLastName };
  }
  if (params.email !== undefined && params.email !== profile.user.email) {
    changes.email = { from: profile.user.email, to: params.email };
  }
  if (params.phone !== undefined && params.phone !== profile.user.phone) {
    changes.phone = { from: profile.user.phone ?? "", to: params.phone };
  }
  if (params.dateOfBirth !== undefined) {
    const nextDateOfBirth = new Date(params.dateOfBirth);
    if (nextDateOfBirth.getTime() !== profile.dateOfBirth?.getTime()) {
      changes.dateOfBirth = {
        from: profile.dateOfBirth?.toISOString() ?? "",
        to: nextDateOfBirth.toISOString(),
      };
    }
  }
  if (params.addressLine1 !== undefined && params.addressLine1 !== profile.addressLine1) {
    changes.addressLine1 = { from: profile.addressLine1 ?? "", to: params.addressLine1 };
  }
  if (params.addressLine2 !== undefined && params.addressLine2 !== profile.addressLine2) {
    changes.addressLine2 = { from: profile.addressLine2 ?? "", to: params.addressLine2 };
  }
  if (params.city !== undefined && params.city !== profile.city) {
    changes.city = { from: profile.city ?? "", to: params.city };
  }
  if (params.region !== undefined && params.region !== profile.region) {
    changes.region = { from: profile.region ?? "", to: params.region };
  }
  if (params.postalCode !== undefined && params.postalCode !== profile.postalCode) {
    changes.postalCode = { from: profile.postalCode ?? "", to: params.postalCode };
  }
  if (params.country !== undefined && params.country !== profile.country) {
    changes.country = { from: profile.country ?? "", to: params.country };
  }
  const currentKycStatus = profile.kyc?.status ?? "NOT_STARTED";
  if (params.kycStatus !== undefined && params.kycStatus !== currentKycStatus) {
    changes.kycStatus = { from: currentKycStatus, to: params.kycStatus };
  }
  if (params.userStatus !== undefined && params.userStatus !== profile.user.status) {
    changes.userStatus = { from: profile.user.status, to: params.userStatus };
  }

  if (Object.keys(changes).length === 0) {
    return getCustomerDetail(params.customerProfileId);
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (
        params.legalFirstName !== undefined ||
        params.legalLastName !== undefined ||
        params.dateOfBirth !== undefined ||
        params.addressLine1 !== undefined ||
        params.addressLine2 !== undefined ||
        params.city !== undefined ||
        params.region !== undefined ||
        params.postalCode !== undefined ||
        params.country !== undefined
      ) {
        await tx.customerProfile.update({
          where: { id: params.customerProfileId },
          data: {
            ...(params.legalFirstName !== undefined ? { legalFirstName: params.legalFirstName } : {}),
            ...(params.legalLastName !== undefined ? { legalLastName: params.legalLastName } : {}),
            ...(params.dateOfBirth !== undefined ? { dateOfBirth: new Date(params.dateOfBirth) } : {}),
            ...(params.addressLine1 !== undefined ? { addressLine1: params.addressLine1 } : {}),
            ...(params.addressLine2 !== undefined ? { addressLine2: params.addressLine2 } : {}),
            ...(params.city !== undefined ? { city: params.city } : {}),
            ...(params.region !== undefined ? { region: params.region } : {}),
            ...(params.postalCode !== undefined ? { postalCode: params.postalCode } : {}),
            ...(params.country !== undefined ? { country: params.country } : {}),
          },
        });
      }
      if (params.email !== undefined || params.phone !== undefined || params.userStatus !== undefined) {
        await tx.user.update({
          where: { id: profile.userId },
          data: {
            ...(params.email !== undefined ? { email: params.email } : {}),
            ...(params.phone !== undefined ? { phone: params.phone } : {}),
            ...(params.userStatus !== undefined ? { status: params.userStatus } : {}),
          },
        });
      }
      if (params.kycStatus !== undefined) {
        await tx.kycRecord.upsert({
          where: { customerProfileId: params.customerProfileId },
          create: { customerProfileId: params.customerProfileId, status: params.kycStatus },
          update: { status: params.kycStatus },
        });
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictError("Another account already uses this email address.");
    }
    throw error;
  }

  await writeAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    action: "customer.details_updated",
    targetType: "CustomerProfile",
    targetId: params.customerProfileId,
    metadata: { changes },
  });

  return getCustomerDetail(params.customerProfileId);
}

export async function listAllAccounts(params: { limit?: number }) {
  return prisma.account.findMany({
    include: { customerProfile: { select: { legalFirstName: true, legalLastName: true } } },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 200,
  });
}

export async function listAllCards(params: { limit?: number }) {
  return prisma.card.findMany({
    include: { account: { include: { customerProfile: { select: { legalFirstName: true, legalLastName: true } } } } },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 200,
  });
}

export async function listAllTransactions(params: { limit?: number; status?: string }) {
  return prisma.transaction.findMany({
    where: params.status ? { status: params.status as never } : undefined,
    include: { customerProfile: { select: { legalFirstName: true, legalLastName: true } } },
    orderBy: { initiatedAt: "desc" },
    take: params.limit ?? 100,
  });
}

export async function listAuditLogs(params: { limit?: number; targetType?: string }) {
  return prisma.auditLog.findMany({
    where: params.targetType ? { targetType: params.targetType } : undefined,
    include: { actor: { select: { email: true } } },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 200,
  });
}

/** Grants admin scopes. Requires ADMIN_MANAGE on the grantor, enforced by
 * the calling route handler via requireAdminScope — this function assumes
 * that check already happened and focuses on the data change + audit. */
export async function grantAdminScopes(params: {
  targetUserId: string;
  scopes: AdminScope[];
  grantedById: string;
}) {
  const target = await prisma.user.findUnique({ where: { id: params.targetUserId } });
  if (!target) throw new NotFoundError("User not found.");
  if (target.role !== "ADMIN") {
    throw new ValidationError("Scopes can only be granted to admin users. Promote the user to ADMIN first.");
  }

  await grantScopes({ userId: params.targetUserId, scopes: params.scopes, grantedById: params.grantedById });

  await writeAuditLog({
    actorUserId: params.grantedById,
    actorRole: "ADMIN",
    action: "admin.permission_granted",
    targetType: "User",
    targetId: params.targetUserId,
    metadata: { scopes: params.scopes },
  });
}

export async function revokeAdminScopes(params: { targetUserId: string; scopes: AdminScope[]; revokedById: string }) {
  await revokeScopes({ userId: params.targetUserId, scopes: params.scopes });

  await writeAuditLog({
    actorUserId: params.revokedById,
    actorRole: "ADMIN" as UserRole,
    action: "admin.permission_revoked",
    targetType: "User",
    targetId: params.targetUserId,
    metadata: { scopes: params.scopes },
  });
}

export async function setCustomerStatus(params: {
  customerUserId: string;
  status: "ACTIVE" | "SUSPENDED" | "CLOSED";
  actorUserId: string;
  reason: string;
}) {
  const updated = await prisma.user.update({ where: { id: params.customerUserId }, data: { status: params.status } });

  await writeAuditLog({
    actorUserId: params.actorUserId,
    actorRole: "ADMIN",
    action: "customer.status_changed",
    targetType: "User",
    targetId: params.customerUserId,
    metadata: { newStatus: params.status, reason: params.reason },
  });

  return updated;
}
