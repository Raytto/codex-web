import type { ConversationPage } from "./api";

export function resetProjectConversationPage(page: ConversationPage, pageSize: number): ConversationPage {
  const conversations = page.conversations.slice(0, pageSize);
  const hasMore = conversations.length < page.total;
  const nextOffset = hasMore ? conversations.length : null;
  if (conversations.length === page.conversations.length && hasMore === page.hasMore && nextOffset === page.nextOffset) return page;
  return { ...page, conversations, hasMore, nextOffset };
}
