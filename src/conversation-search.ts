import type { Conversation, ConversationPage } from "./api";

export function sortConversationsByActivity(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((left, right) => {
    const leftPinned = Boolean(left.pinned_at);
    const rightPinned = Boolean(right.pinned_at);
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    return right.sidebar_order - left.sidebar_order || left.id.localeCompare(right.id);
  });
}

export function mergeConversationMatches(current: Conversation[], incoming: Conversation[]): Conversation[] {
  const known = new Set(current.map((conversation) => conversation.id));
  return [...current, ...incoming.filter((conversation) => !known.has(conversation.id))];
}

export function retainSelectedConversation(
  page: ConversationPage,
  selected: Conversation | null,
  projectId?: string,
): ConversationPage {
  if (!selected || (projectId && selected.project_id !== projectId)) return page;
  if (page.conversations.some((conversation) => conversation.id === selected.id)) return page;
  return {
    ...page,
    // Keep a selected task visible when it falls outside a refreshed page, but
    // never turn selection itself into a sidebar ordering event.
    conversations: [...page.conversations, selected],
  };
}

export function removeConversationFromPage(page: ConversationPage, conversationId: string): ConversationPage {
  if (!page.conversations.some((conversation) => conversation.id === conversationId)) return page;
  return {
    ...page,
    conversations: page.conversations.filter((conversation) => conversation.id !== conversationId),
    total: Math.max(0, page.total - 1),
  };
}
