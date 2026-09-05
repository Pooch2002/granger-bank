import "server-only";
import { getEnv, isProduction } from "../env";
import {
  UnconfiguredAccountProvider,
  UnconfiguredBankingProvider,
  UnconfiguredCardProvider,
  UnconfiguredEmailProvider,
  UnconfiguredFraudRiskProvider,
  UnconfiguredKycProvider,
  UnconfiguredPaymentProvider,
  UnconfiguredTransactionProvider,
} from "./unconfigured";
import { ConsoleEmailProvider, HttpEmailProvider } from "./emailProviders";
import type {
  AccountProvider,
  BankingProvider,
  CardProvider,
  EmailProvider,
  FraudRiskProvider,
  KycProvider,
  PaymentProvider,
  TransactionProvider,
} from "./types";

/**
 * Central resolution point for every provider. A real implementation is
 * wired in here, and only here, once Phase 10
 * (docs/production/09-client-requirements-and-credentials.md) is resolved
 * with the client — no other file in the codebase should import a vendor
 * SDK directly.
 *
 * Per explicit instruction: there is no synthetic-data "dev stub" for any
 * financial provider, in any environment, including local development.
 * Absent real credentials, every financial provider fails closed — always.
 * The only environment-conditional adapter is email delivery (§ below),
 * which is not a financial function.
 */

let banking: BankingProvider | null = null;
export function getBankingProvider(): BankingProvider {
  if (banking) return banking;
  const env = getEnv();
  if (env.BANKING_API_URL && env.BANKING_API_KEY) {
    // A real implementation is registered here once Phase 10 names the
    // client's authorized provider. Intentionally not implemented yet.
    throw new Error(
      "BANKING_API_URL/KEY are set but no BankingProvider implementation is registered. " +
        "Implement one against the client's actual provider contract before enabling this."
    );
  }
  banking = new UnconfiguredBankingProvider();
  return banking;
}

let account: AccountProvider | null = null;
export function getAccountProvider(): AccountProvider {
  if (account) return account;
  const env = getEnv();
  if (env.BANKING_API_URL && env.BANKING_API_KEY) {
    throw new Error("AccountProvider is not implemented against a real provider yet.");
  }
  account = new UnconfiguredAccountProvider();
  return account;
}

let payment: PaymentProvider | null = null;
export function getPaymentProvider(): PaymentProvider {
  if (payment) return payment;
  const env = getEnv();
  if (env.PAYMENT_API_URL && env.PAYMENT_API_KEY) {
    throw new Error("PaymentProvider is not implemented against a real provider yet.");
  }
  payment = new UnconfiguredPaymentProvider();
  return payment;
}

let transaction: TransactionProvider | null = null;
export function getTransactionProvider(): TransactionProvider {
  if (transaction) return transaction;
  const env = getEnv();
  if (env.BANKING_API_URL && env.BANKING_API_KEY) {
    throw new Error("TransactionProvider is not implemented against a real provider yet.");
  }
  transaction = new UnconfiguredTransactionProvider();
  return transaction;
}

let card: CardProvider | null = null;
export function getCardProvider(): CardProvider {
  if (card) return card;
  const env = getEnv();
  if (env.CARD_PROVIDER_API_URL && env.CARD_PROVIDER_API_KEY) {
    throw new Error("CardProvider is not implemented against a real provider yet.");
  }
  card = new UnconfiguredCardProvider();
  return card;
}

let kyc: KycProvider | null = null;
export function getKycProvider(): KycProvider {
  if (kyc) return kyc;
  const env = getEnv();
  if (env.KYC_PROVIDER_API_URL && env.KYC_PROVIDER_API_KEY) {
    throw new Error("KycProvider is not implemented against a real provider yet.");
  }
  kyc = new UnconfiguredKycProvider();
  return kyc;
}

let fraud: FraudRiskProvider | null = null;
export function getFraudRiskProvider(): FraudRiskProvider {
  if (fraud) return fraud;
  const env = getEnv();
  if (env.FRAUD_PROVIDER_API_URL && env.FRAUD_PROVIDER_API_KEY) {
    throw new Error("FraudRiskProvider is not implemented against a real provider yet.");
  }
  fraud = new UnconfiguredFraudRiskProvider();
  return fraud;
}

let email: EmailProvider | null = null;
export function getEmailProvider(): EmailProvider {
  if (email) return email;
  const env = getEnv();
  if (env.EMAIL_PROVIDER_API_URL && env.EMAIL_PROVIDER_API_KEY && env.EMAIL_FROM_ADDRESS) {
    email = new HttpEmailProvider(env.EMAIL_PROVIDER_API_URL, env.EMAIL_PROVIDER_API_KEY, env.EMAIL_FROM_ADDRESS);
    return email;
  }
  // Email is not a financial function — the console adapter is a
  // development convenience only, never selected in production.
  email = isProduction() ? new UnconfiguredEmailProvider() : new ConsoleEmailProvider();
  return email;
}
