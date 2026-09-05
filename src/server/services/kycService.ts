import "server-only";
import { prisma } from "../db";
import { getKycProvider } from "../providers/registry";
import { writeAuditLog } from "../security/audit";
import { NotFoundError, ValidationError } from "../security/errors";
import type { UserRole } from "@prisma/client";

/**
 * KYC workflow orchestration. See docs/production/03-database-schema.md
 * (Customer/KYC) and docs/production/10-compliance-and-regulatory.md.
 *
 * This service NEVER sets KycRecord.status to APPROVED itself — that value
 * only ever comes from KycProvider.getVerificationStatus(), i.e. from the
 * real verification vendor once one is integrated. Until then,
 * startVerification fails closed (ProviderNotConfiguredError) and every
 * customer's KYC status remains NOT_STARTED.
 */

export async function startVerification(customerProfileId: string, actorUserId: string, actorRole: UserRole) {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    include: { kyc: true, user: true },
  });
  if (!profile) throw new NotFoundError("Customer profile not found.");

  // Date of birth and address aren't collected at registration (see
  // src/app/api/auth/register/route.ts) — they're only gathered here, right
  // before actually starting verification with a provider that needs them.
  if (!profile.dateOfBirth || !profile.country) {
    throw new ValidationError("Add your date of birth and address before starting identity verification.");
  }

  // Fails closed until a real KYC provider is configured — see
  // src/server/providers/unconfigured.ts. Intentionally not caught here:
  // the caller (API route) surfaces the 503 to the client as-is.
  const provider = getKycProvider();
  const { providerCaseId } = await provider.startVerification({
    customerProfileId,
    legalFirstName: profile.legalFirstName,
    legalLastName: profile.legalLastName,
    dateOfBirth: profile.dateOfBirth,
    country: profile.country,
  });

  const updated = await prisma.kycRecord.update({
    where: { customerProfileId },
    data: { status: "PENDING", provider: provider.name, providerCaseId, submittedAt: new Date() },
  });

  await writeAuditLog({
    actorUserId,
    actorRole,
    action: "kyc.verification_started",
    targetType: "CustomerProfile",
    targetId: customerProfileId,
  });

  return updated;
}

/** Polls the provider for a decision and reflects it locally. Never invents
 * a decision — if the provider isn't configured, this throws rather than
 * defaulting to any particular status. */
export async function refreshVerificationStatus(customerProfileId: string) {
  const record = await prisma.kycRecord.findUnique({ where: { customerProfileId } });
  if (!record?.providerCaseId) throw new NotFoundError("No verification in progress for this customer.");

  const provider = getKycProvider();
  const result = await provider.getVerificationStatus(record.providerCaseId);

  return prisma.kycRecord.update({
    where: { customerProfileId },
    data: {
      status: result.status,
      riskRating: result.riskRating,
      rejectionReason: result.reason,
      decidedAt: ["APPROVED", "REJECTED"].includes(result.status) ? new Date() : record.decidedAt,
    },
  });
}
