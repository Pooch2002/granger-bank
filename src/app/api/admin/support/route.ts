import { withErrorHandling, jsonOk } from "@/server/http/respond";
import { requireAdminScope } from "@/server/auth/guards";
import { listOpenConversations } from "@/server/services/adminService";

export const GET = withErrorHandling(async () => {
  await requireAdminScope("SUPPORT_RESPOND");

  const conversations = await listOpenConversations({});
  return jsonOk({ conversations });
});
