import { z } from "zod";
import { withErrorHandling, jsonOk, serializeMoney } from "@/server/http/respond";
import { requireAdminScope } from "@/server/auth/guards";
import { assertCsrf } from "@/server/security/csrf";
import { parseJsonBody, emailSchema } from "@/server/security/validation";
import { getCustomerDetail, updateCustomerDetails } from "@/server/services/adminService";

export const GET = withErrorHandling(
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    await requireAdminScope("CUSTOMERS_VIEW");
    const { id } = await params;

    const customer = await getCustomerDetail(id);
    return jsonOk(serializeMoney({ customer }));
  }
);

const updateSchema = z.object({
  legalFirstName: z.string().trim().min(1).max(100).optional(),
  legalLastName: z.string().trim().min(1).max(100).optional(),
  email: emailSchema.optional(),
  phone: z.string().trim().min(1).max(20).optional(),
  dateOfBirth: z.string().date().optional(),
  addressLine1: z.string().trim().min(1).max(200).optional(),
  addressLine2: z.string().trim().min(1).max(200).optional(),
  city: z.string().trim().min(1).max(200).optional(),
  region: z.string().trim().min(1).max(200).optional(),
  postalCode: z.string().trim().min(1).max(200).optional(),
  country: z.string().trim().length(2).optional(),
  kycStatus: z.enum(["NOT_STARTED", "PENDING", "IN_REVIEW", "APPROVED", "REJECTED", "EXPIRED"]).optional(),
  userStatus: z.enum(["PENDING_VERIFICATION", "ACTIVE", "SUSPENDED", "CLOSED"]).optional(),
});

export const PATCH = withErrorHandling(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    await assertCsrf(request);
    const ctx = await requireAdminScope("CUSTOMERS_MANAGE");
    const { id } = await params;
    const input = await parseJsonBody(request, updateSchema);

    const customer = await updateCustomerDetails({
      customerProfileId: id,
      ...input,
      actorUserId: ctx.user.id,
      actorRole: ctx.user.role,
    });
    return jsonOk(serializeMoney({ customer }));
  }
);
