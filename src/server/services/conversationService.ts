import "server-only";
import { prisma } from "../db";

export async function getOrCreateOpenConversation(customerProfileId: string) {
  const existing = await prisma.conversation.findFirst({
    where: { customerProfileId, status: "OPEN" },
  });
  if (existing) return existing;

  return prisma.conversation.create({
    data: { customerProfileId, status: "OPEN" },
  });
}

export async function listMessagesForConversation(conversationId: string) {
  return prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    include: { sender: { select: { email: true, role: true } } },
  });
}

export async function postMessage(params: { conversationId: string; senderUserId: string; body: string }) {
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId: params.conversationId,
        senderUserId: params.senderUserId,
        body: params.body,
      },
    });

    await tx.conversation.update({
      where: { id: params.conversationId },
      data: { lastMessageAt: new Date() },
    });

    return message;
  });
}
