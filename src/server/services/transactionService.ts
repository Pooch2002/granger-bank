import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { getPaymentProvider, getFraudRiskProvider } from "../providers/registry";
import { ProviderNotConfiguredError } from "../security/errors";
import { writeAuditLog } from "../security/audit";
import { assertAccountOwnership } from "./accountService";
import { ForbiddenError, NotFoundError, ValidationError } from "../security/errors";
import type { TransactionStatus, UserRole } from "@prisma/client";

/**
 * External transfer orchestration implementing the state machine and
 * idempotency design in docs/production/05-transaction-architecture.md.
 * Always goes to a saved Beneficiary — money leaving Granger Bank entirely,
 * as opposed to createInternalTransfer below, which moves fake seeded money
 * between two of a customer's own Granger Bank accounts.
 *
 * This function NEVER writes to Account.cachedBalanceMinor as a side
 * effect of "success" — there is no success path here that isn't gated by
 * a real PaymentProvider, which is unconfigured in this build (per
 * explicit instruction). Every transfer attempted right now will
 * legitimately fail at the SUBMITTED_TO_PROVIDER step with a clear,
 * honest reason — that failure, fully recorded, IS the correct behavior,
 * not a bug to work around.
 */

export type CreateExternalTransferInput = {
  idempotencyKey: string;
  customerProfileId: string;
  sourceAccountId: string;
  beneficiaryId: string;
  amountMinor: bigint;
  currency: string;
  reference: string;
  description?: string;
  actorUserId: string;
  actorRole: UserRole;
  ipAddress: string;
};

async function transitionStatus(transactionId: string, toStatus: TransactionStatus, reason: string | null, actor: string) {
  const current = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
  await prisma.$transaction([
    prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: toStatus,
        ...(toStatus === "AUTHORIZED" ? { authorizedAt: new Date() } : {}),
        ...(toStatus === "SETTLED" ? { settledAt: new Date() } : {}),
        ...(toStatus === "FAILED" ? { failedAt: new Date(), failureReason: reason ?? undefined } : {}),
      },
    }),
    prisma.transactionStatusEvent.create({
      data: { transactionId, fromStatus: current.status, toStatus, reason, actor },
    }),
  ]);
}

export async function createExternalTransfer(input: CreateExternalTransferInput) {
  // --- Idempotency: a second request with the same key returns the first
  // request's transaction rather than creating a duplicate or erroring. ---
  const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return existing;

  // --- Ownership checks (server-side, always) ---
  const sourceAccount = await assertAccountOwnership(input.sourceAccountId, input.customerProfileId);
  if (sourceAccount.status !== "ACTIVE") {
    throw new ValidationError("The source account is not active.");
  }

  const beneficiary = await prisma.beneficiary.findUnique({ where: { id: input.beneficiaryId } });
  if (!beneficiary || beneficiary.customerProfileId !== input.customerProfileId) {
    throw new ForbiddenError();
  }
  if (beneficiary.status !== "VERIFIED") {
    throw new ValidationError(
      "This beneficiary has not completed verification yet and cannot receive transfers."
    );
  }

  // --- Create the transaction record (INITIATED). Unique constraint on
  // idempotencyKey protects against a concurrent duplicate race. ---
  let transaction;
  try {
    transaction = await prisma.transaction.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        customerProfileId: input.customerProfileId,
        sourceAccountId: input.sourceAccountId,
        beneficiaryId: input.beneficiaryId,
        type: "EXTERNAL_TRANSFER",
        direction: "DEBIT",
        amountMinor: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
        description: input.description,
        status: "INITIATED",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Lost the race to a concurrent identical request — return its result.
      const winner = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (winner) return winner;
    }
    throw error;
  }

  await prisma.transactionStatusEvent.create({
    data: { transactionId: transaction.id, fromStatus: null, toStatus: "INITIATED", actor: "system" },
  });
  await writeAuditLog({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "transaction.initiated",
    targetType: "Transaction",
    targetId: transaction.id,
    transactionId: transaction.id,
    ipAddress: input.ipAddress,
  });

  // --- Risk scoring (best-effort; a secondary, non-blocking provider) ---
  try {
    const risk = await getFraudRiskProvider().scoreTransaction({
      customerProfileId: input.customerProfileId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      destinationDescriptor: beneficiary.name,
    });
    await prisma.transaction.update({ where: { id: transaction.id }, data: { riskScore: risk.score, riskFlags: risk.flags } });
    if (risk.score >= 80) {
      await transitionStatus(transaction.id, "PENDING_RISK_REVIEW", "risk_score_high", "system");
      return prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    }
  } catch (error) {
    if (!(error instanceof ProviderNotConfiguredError)) throw error;
    // No fraud provider configured yet — this does not block the flow;
    // the payment provider call below is the actual gate on money moving.
  }

  await transitionStatus(transaction.id, "AUTHORIZED", null, "system");

  // --- Submit to the payment provider. This is the step that actually
  // moves money, and it is the step that is unconfigured in this build.
  // The failure here is not caught-and-hidden: it is recorded as the
  // transaction's real, final state. ---
  await transitionStatus(transaction.id, "SUBMITTED_TO_PROVIDER", null, "system");
  try {
    const provider = getPaymentProvider();
    const result = await provider.submitTransfer({
      providerRequestId: transaction.idempotencyKey,
      sourceAccountRef: sourceAccount.providerAccountRef ?? "",
      amountMinor: input.amountMinor,
      currency: input.currency,
      reference: input.reference,
    });

    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { provider: provider.name, providerTxnRef: result.providerTxnRef, providerStatus: result.status },
    });
    // A real provider integration maps its status vocabulary to SETTLED/
    // FAILED here, or (more commonly) waits for a webhook — see
    // docs/production/06-banking-provider-integration.md §1. Not reached
    // in this build.
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      await transitionStatus(
        transaction.id,
        "FAILED",
        "No payment provider is configured for this environment. This transfer was not submitted anywhere and no money moved.",
        "system"
      );
    } else {
      await transitionStatus(transaction.id, "FAILED", "Unexpected error submitting to payment provider.", "system");
      throw error;
    }
  }

  await writeAuditLog({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "transaction.provider_submission_result",
    targetType: "Transaction",
    targetId: transaction.id,
    transactionId: transaction.id,
    ipAddress: input.ipAddress,
  });

  return prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
}

export type CreateInternalTransferInput = {
  idempotencyKey: string;
  customerProfileId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amountMinor: bigint;
  currency: string;
  reference: string;
  description?: string;
  actorUserId: string;
  actorRole: UserRole;
  ipAddress: string;
};

/**
 * Moves fake seeded money between two of a customer's own Granger Bank
 * accounts, instantly and atomically — deliberately different from
 * createExternalTransfer above. That function's entire point is to fail
 * honestly because no real payment provider is connected in this build;
 * this one exists because internal transfers never leave Granger Bank, so
 * there is nothing for a provider to do — Granger Bank is its own source of
 * truth for its own accounts' balances (see internalLedgerBalanceMinor in
 * schema.prisma), no different from any real bank's core ledger settling a
 * between-your-own-accounts transfer immediately.
 */
export async function createInternalTransfer(input: CreateInternalTransferInput) {
  if (input.amountMinor <= BigInt(0)) {
    throw new ValidationError("Transfer amount must be greater than zero.");
  }
  if (input.sourceAccountId === input.destinationAccountId) {
    throw new ValidationError("Source and destination accounts must be different.");
  }

  // --- Idempotency: a second request with the same key returns the first
  // request's transaction rather than creating a duplicate or erroring. ---
  const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return existing;

  // --- Ownership checks (server-side, always) — both accounts must belong
  // to the calling customer. This function does not support sending to a
  // different customer's account; that would need its own authorization
  // and recipient-lookup design, deliberately out of scope here. ---
  const sourceAccount = await assertAccountOwnership(input.sourceAccountId, input.customerProfileId);
  const destinationAccount = await assertAccountOwnership(input.destinationAccountId, input.customerProfileId);

  if (sourceAccount.status !== "ACTIVE") {
    throw new ValidationError("The source account is not active.");
  }
  if (destinationAccount.status !== "ACTIVE") {
    throw new ValidationError("The destination account is not active.");
  }
  if (sourceAccount.currency !== input.currency || destinationAccount.currency !== input.currency) {
    throw new ValidationError("Currency mismatch between the accounts and the transfer request.");
  }

  // --- Create the transaction record (INITIATED). Unique constraint on
  // idempotencyKey protects against a concurrent duplicate race. ---
  let transaction;
  try {
    transaction = await prisma.transaction.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        customerProfileId: input.customerProfileId,
        sourceAccountId: input.sourceAccountId,
        destinationAccountId: input.destinationAccountId,
        type: "INTERNAL_TRANSFER",
        direction: "DEBIT",
        amountMinor: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
        description: input.description,
        status: "INITIATED",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Lost the race to a concurrent identical request — return its result.
      const winner = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (winner) return winner;
    }
    throw error;
  }

  await prisma.transactionStatusEvent.create({
    data: { transactionId: transaction.id, fromStatus: null, toStatus: "INITIATED", actor: "system" },
  });

  // --- The atomic debit/credit. The conditional updateMany (WHERE balance
  // >= amount) is the compare-and-swap that makes this race-safe: two
  // concurrent transfers debiting the same account can't both pass an
  // application-level "read balance, check, then write" check against a
  // balance that's gone stale between the read and the write — Postgres
  // evaluates the WHERE clause and applies the UPDATE atomically, in one
  // statement. Wrapping both writes (plus the status transition) in
  // prisma.$transaction means they all commit together or all roll back
  // together — never a partial transfer, per the explicit requirement. ---
  try {
    await prisma.$transaction(async (tx) => {
      const debited = await tx.account.updateMany({
        where: { id: sourceAccount.id, internalLedgerBalanceMinor: { gte: input.amountMinor } },
        data: { internalLedgerBalanceMinor: { decrement: input.amountMinor } },
      });
      if (debited.count === 0) {
        throw new ValidationError("This transfer would overdraw the source account.");
      }

      // internalLedgerBalanceMinor is nullable (an account that's never
      // been funded has no ledger balance at all yet) — a plain Prisma
      // `increment` translates to SQL `x = x + $amount`, and NULL + anything
      // is NULL in Postgres, which would silently discard a first-ever
      // credit while this function still reports the transfer as SETTLED.
      // Backfill null to 0 first, in the same transaction, before
      // incrementing — see the identical fix in createAdminAccountCredit
      // below.
      await tx.account.updateMany({
        where: { id: destinationAccount.id, internalLedgerBalanceMinor: null },
        data: { internalLedgerBalanceMinor: BigInt(0) },
      });
      await tx.account.update({
        where: { id: destinationAccount.id },
        data: { internalLedgerBalanceMinor: { increment: input.amountMinor } },
      });

      const current = await tx.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
      await tx.transaction.update({
        where: { id: transaction.id },
        data: { status: "SETTLED", authorizedAt: new Date(), settledAt: new Date() },
      });
      await tx.transactionStatusEvent.createMany({
        data: [
          { transactionId: transaction.id, fromStatus: current.status, toStatus: "AUTHORIZED", actor: "system" },
          {
            transactionId: transaction.id,
            fromStatus: "AUTHORIZED",
            toStatus: "SETTLED",
            actor: "system",
            reason: "internal_ledger_transfer",
          },
        ],
      });
    });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    await transitionStatus(transaction.id, "FAILED", error.message, "system");
    return prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
  }

  await writeAuditLog({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "transaction.internal_transfer_settled",
    targetType: "Transaction",
    targetId: transaction.id,
    transactionId: transaction.id,
    ipAddress: input.ipAddress,
  });

  return prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
}

export type CreateAdminAccountCreditInput = {
  idempotencyKey: string;
  accountId: string;
  amountMinor: bigint;
  reason: string;
  actorUserId: string;
  actorRole: UserRole;
  ipAddress: string;
};

/**
 * Admin-only tool: adds fake demo money directly to an account's internal
 * ledger balance, since there's no real banking provider connected to fund
 * accounts through. Deliberately separate from createInternalTransfer/
 * createExternalTransfer above — this never claims to represent money
 * entering Granger Bank from anywhere real, and refuses any account with a
 * providerAccountRef set, since that account's balance would be
 * provider-authoritative and this internal tool has no business touching
 * it. Always creates a real, auditable Transaction (type: ADJUSTMENT,
 * direction: CREDIT) plus an AuditLog entry — never a silent balance edit,
 * per the explicit requirement this exists to satisfy.
 */
export async function createAdminAccountCredit(input: CreateAdminAccountCreditInput) {
  if (input.amountMinor <= BigInt(0)) {
    throw new ValidationError("Credit amount must be greater than zero.");
  }

  // --- Idempotency: a second request with the same key (e.g. an admin's
  // double-click) returns the first request's transaction rather than
  // crediting twice. ---
  const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return existing;

  const account = await prisma.account.findUnique({ where: { id: input.accountId } });
  if (!account) throw new NotFoundError("Account not found.");
  if (account.providerAccountRef) {
    throw new ValidationError(
      "This account is connected to a real banking provider. The account credit tool only works on accounts with no provider connected."
    );
  }
  if (account.status !== "ACTIVE") {
    throw new ValidationError("The account is not active.");
  }

  let transaction;
  try {
    transaction = await prisma.transaction.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        customerProfileId: account.customerProfileId,
        destinationAccountId: account.id,
        type: "ADJUSTMENT",
        direction: "CREDIT",
        amountMinor: input.amountMinor,
        currency: account.currency,
        reference: "Account credit",
        description: input.reason,
        status: "INITIATED",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Lost the race to a concurrent identical request — return its result.
      const winner = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (winner) return winner;
    }
    throw error;
  }

  await prisma.transactionStatusEvent.create({
    data: { transactionId: transaction.id, fromStatus: null, toStatus: "INITIATED", actor: input.actorUserId },
  });

  await prisma.$transaction(async (tx) => {
    // internalLedgerBalanceMinor is nullable (an account that's never been
    // funded has no ledger balance at all yet) — a plain Prisma `increment`
    // translates to SQL `x = x + $amount`, and NULL + anything is NULL in
    // Postgres, which would silently discard a first-ever credit while
    // still recording a SETTLED transaction claiming it happened. Backfill
    // null to 0 first, in the same transaction, before incrementing.
    await tx.account.updateMany({
      where: { id: account.id, internalLedgerBalanceMinor: null },
      data: { internalLedgerBalanceMinor: BigInt(0) },
    });
    await tx.account.update({
      where: { id: account.id },
      data: { internalLedgerBalanceMinor: { increment: input.amountMinor } },
    });

    await tx.transaction.update({
      where: { id: transaction.id },
      data: { status: "SETTLED", authorizedAt: new Date(), settledAt: new Date() },
    });
    await tx.transactionStatusEvent.createMany({
      data: [
        { transactionId: transaction.id, fromStatus: "INITIATED", toStatus: "AUTHORIZED", actor: input.actorUserId },
        {
          transactionId: transaction.id,
          fromStatus: "AUTHORIZED",
          toStatus: "SETTLED",
          actor: input.actorUserId,
          reason: "admin_demo_credit",
        },
      ],
    });
  });

  await writeAuditLog({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "account.admin_credit_applied",
    targetType: "Account",
    targetId: account.id,
    transactionId: transaction.id,
    ipAddress: input.ipAddress,
    metadata: {
      amountMinor: input.amountMinor.toString(),
      currency: account.currency,
      reason: input.reason,
      customerProfileId: account.customerProfileId,
    },
  });

  return prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
}

export type CreateAdminAccountDebitInput = {
  idempotencyKey: string;
  accountId: string;
  amountMinor: bigint;
  reason: string;
  actorUserId: string;
  actorRole: UserRole;
  ipAddress: string;
};

/**
 * Admin-only tool: removes money from an account's internal ledger balance.
 * Mirrors createAdminAccountCredit above (same idempotency, ownership-free
 * lookup, providerAccountRef guard, active-account guard), but the balance
 * write is overdraw-safe rather than null-backfilled — unlike a credit,
 * there is no sensible "succeed anyway" outcome for a debit against a
 * missing or insufficient balance, so it fails instead, same as the
 * conditional updateMany in createInternalTransfer above.
 */
export async function createAdminAccountDebit(input: CreateAdminAccountDebitInput) {
  if (input.amountMinor <= BigInt(0)) {
    throw new ValidationError("Debit amount must be greater than zero.");
  }

  // --- Idempotency: a second request with the same key (e.g. an admin's
  // double-click) returns the first request's transaction rather than
  // debiting twice. ---
  const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return existing;

  const account = await prisma.account.findUnique({ where: { id: input.accountId } });
  if (!account) throw new NotFoundError("Account not found.");
  if (account.providerAccountRef) {
    throw new ValidationError(
      "This account is connected to a real banking provider. The account debit tool only works on accounts with no provider connected."
    );
  }
  if (account.status !== "ACTIVE") {
    throw new ValidationError("The account is not active.");
  }

  let transaction;
  try {
    transaction = await prisma.transaction.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        customerProfileId: account.customerProfileId,
        sourceAccountId: account.id,
        type: "ADJUSTMENT",
        direction: "DEBIT",
        amountMinor: input.amountMinor,
        currency: account.currency,
        reference: "Account debit",
        description: input.reason,
        status: "INITIATED",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Lost the race to a concurrent identical request — return its result.
      const winner = await prisma.transaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (winner) return winner;
    }
    throw error;
  }

  await prisma.transactionStatusEvent.create({
    data: { transactionId: transaction.id, fromStatus: null, toStatus: "INITIATED", actor: input.actorUserId },
  });

  await prisma.$transaction(async (tx) => {
    // Conditional updateMany (WHERE balance >= amount) is the atomic
    // compare-and-swap that prevents overdrawing under concurrent debits —
    // same reasoning as the source-account debit in createInternalTransfer
    // above. If it affects zero rows, throw here so the transaction record's
    // SETTLED update below never commits and rolls back with everything else.
    const debited = await tx.account.updateMany({
      where: { id: account.id, internalLedgerBalanceMinor: { gte: input.amountMinor } },
      data: { internalLedgerBalanceMinor: { decrement: input.amountMinor } },
    });
    if (debited.count === 0) {
      throw new ValidationError("This debit would overdraw the account.");
    }

    await tx.transaction.update({
      where: { id: transaction.id },
      data: { status: "SETTLED", authorizedAt: new Date(), settledAt: new Date() },
    });
    await tx.transactionStatusEvent.createMany({
      data: [
        { transactionId: transaction.id, fromStatus: "INITIATED", toStatus: "AUTHORIZED", actor: input.actorUserId },
        {
          transactionId: transaction.id,
          fromStatus: "AUTHORIZED",
          toStatus: "SETTLED",
          actor: input.actorUserId,
          reason: "admin_demo_debit",
        },
      ],
    });
  });

  await writeAuditLog({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "account.admin_debit_applied",
    targetType: "Account",
    targetId: account.id,
    transactionId: transaction.id,
    ipAddress: input.ipAddress,
    metadata: {
      amountMinor: input.amountMinor.toString(),
      currency: account.currency,
      reason: input.reason,
      customerProfileId: account.customerProfileId,
    },
  });

  return prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
}

/** Admin action on a transaction held in PENDING_RISK_REVIEW. Moving it to
 * AUTHORIZED still does not move any money — the next step is the same
 * fail-closed PaymentProvider submission every transfer goes through. See
 * docs/production/07-security-architecture.md §8 (TRANSFERS_APPROVE scope). */
export async function adminReviewTransaction(params: {
  transactionId: string;
  decision: "APPROVE" | "REJECT";
  actorUserId: string;
  actorRole: UserRole;
  reason?: string;
}) {
  const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: params.transactionId } });
  if (transaction.status !== "PENDING_RISK_REVIEW") {
    throw new ValidationError("Only transactions pending risk review can be approved or rejected here.");
  }

  await transitionStatus(
    params.transactionId,
    params.decision === "APPROVE" ? "AUTHORIZED" : "REJECTED",
    params.reason ?? null,
    params.actorUserId
  );

  await writeAuditLog({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    action: params.decision === "APPROVE" ? "transaction.risk_approved" : "transaction.risk_rejected",
    targetType: "Transaction",
    targetId: params.transactionId,
    transactionId: params.transactionId,
    metadata: { reason: params.reason },
  });

  return prisma.transaction.findUniqueOrThrow({ where: { id: params.transactionId } });
}

export async function listTransactionsForCustomer(customerProfileId: string, limit = 50) {
  return prisma.transaction.findMany({
    where: { customerProfileId },
    orderBy: { initiatedAt: "desc" },
    take: limit,
    include: { sourceAccount: true, destinationAccount: true, beneficiary: true },
  });
}

export async function getTransactionForCustomer(transactionId: string, customerProfileId: string) {
  const transaction = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: { statusHistory: { orderBy: { createdAt: "asc" } } },
  });
  if (!transaction) throw new NotFoundError("Transaction not found.");
  if (transaction.customerProfileId !== customerProfileId) throw new ForbiddenError();
  return transaction;
}
