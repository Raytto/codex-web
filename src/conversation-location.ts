const conversationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readConversationLocation(href: string) {
  const params = new URL(href).searchParams;
  const value = params.get("conversation");
  return {
    explicit: params.has("conversation"),
    id: value && conversationIdPattern.test(value) ? value.toLowerCase() : null,
  };
}

export function conversationLocation(href: string, id: string | null): string {
  const url = new URL(href);
  if (id) url.searchParams.set("conversation", id);
  else url.searchParams.delete("conversation");
  return url.href;
}
