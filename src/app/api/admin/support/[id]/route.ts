import { z } from "zod";
import { withErrorHandling, jsonOk } from "@/server/http/respond";
import { requireAdminScope } from "@/server/auth/guards";
import { assertCsrf } from "@/server/security/csrf";
import { parseJsonBody } from "@/server/security/validation";
import { getConversationDetail } from "@/server/services/adminService";
import { postMessage } from "@/server/services/conversationService";

export const GET = withErrorHandling(
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    await requireAdminScope("SUPPORT_RESPOND");
    const { id } = await params;

    const conversation = await getConversationDetail(id);
    return jsonOk({ conversation });
  }
);

const postMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

export const POST = withErrorHandling(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    await assertCsrf(request);
    const ctx = await requireAdminScope("SUPPORT_RESPOND");
    const { id } = await params;
    const input = await parseJsonBody(request, postMessageSchema);

    const message = await postMessage({
      conversationId: id,
      senderUserId: ctx.user.id,
      body: input.body,
    });

    return jsonOk({ message }, 201);
  }
);
