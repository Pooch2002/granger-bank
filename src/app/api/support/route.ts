import { z } from "zod";
import { parseJsonBody } from "@/server/security/validation";
import { withErrorHandling, jsonOk } from "@/server/http/respond";
import { assertCsrf } from "@/server/security/csrf";
import { requireAuth } from "@/server/auth/guards";
import { getOrCreateOpenConversation, listMessagesForConversation, postMessage } from "@/server/services/conversationService";
import { getCustomerProfileByUserId } from "@/server/services/customerService";

export const GET = withErrorHandling(async () => {
  const ctx = await requireAuth();
  const profile = await getCustomerProfileByUserId(ctx.user.id);
  const conversation = await getOrCreateOpenConversation(profile.id);
  const messages = await listMessagesForConversation(conversation.id);
  return jsonOk({ conversation, messages });
});

const postMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

export const POST = withErrorHandling(async (request: Request) => {
  await assertCsrf(request);
  const ctx = await requireAuth();
  const profile = await getCustomerProfileByUserId(ctx.user.id);
  const input = await parseJsonBody(request, postMessageSchema);

  const conversation = await getOrCreateOpenConversation(profile.id);
  const message = await postMessage({
    conversationId: conversation.id,
    senderUserId: ctx.user.id,
    body: input.body,
  });

  return jsonOk({ message }, 201);
});
