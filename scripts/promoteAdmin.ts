/**
 * One-off script: promotes an already-registered user to ADMIN with the
 * full Super Admin scope bundle. Run once per admin, against production,
 * using the unpooled DB connection. Not called from the app itself.
 *
 * Usage: npx tsx scripts/promoteAdmin.ts <email>
 */
import { PrismaClient } from "@prisma/client";
import { grantScopes } from "../src/server/auth/rbacCore";

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx tsx scripts/promoteAdmin.ts <email>");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });

  if (!user) {
    console.error(`No user found with email ${email}. They must register first.`);
    process.exit(1);
  }

  if (!user.emailVerifiedAt) {
    console.error(`${email} has not verified their email yet. They need to click the verification link first.`);
    process.exit(1);
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: "ADMIN" },
  });

  await grantScopes({
    userId: updated.id,
    grantedById: updated.id,
    scopes: [
      "CUSTOMERS_VIEW",
      "CUSTOMERS_MANAGE",
      "ACCOUNTS_VIEW",
      "ACCOUNTS_MANAGE",
      "TRANSACTIONS_VIEW",
      "TRANSFERS_APPROVE",
      "CARDS_MANAGE",
      "SUPPORT_RESPOND",
      "COMPLIANCE_REVIEW",
      "RISK_REVIEW",
      "AUDIT_LOG_VIEW",
      "SETTINGS_MANAGE",
      "ADMIN_MANAGE",
    ],
  });

  console.log(`Promoted ${updated.email} to ADMIN with full scopes.`);
  console.log("They must enroll MFA from Security settings before the admin console accepts them.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
