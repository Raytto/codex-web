import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CornerUpLeft, LoaderCircle, Zap } from "lucide-react";
import type { Message } from "../api";
import { sanitizeAgentMarkdown } from "../agent-content";
import type { ConversationMessageVariant } from "./conversation-types";

export function ConversationMarkdown({ content, className = "markdown" }: { content: string; className?: string }) {
  return <div className={className}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{sanitizeAgentMarkdown(content)}</ReactMarkdown></div>;
}

export function ConversationQuote({ excerpt, className = "message-reference", label }: { excerpt: string; className?: string; label?: string }) {
  return <div className={className} title={excerpt}><CornerUpLeft size={14} /><span>{label && <strong>{label}</strong>}{excerpt}</span></div>;
}

export type ConversationMessageProps = {
  message: Message;
  variant?: ConversationMessageVariant;
  className?: string;
  avatar?: React.ReactNode;
  avatarClassName?: string;
  name?: string;
  timeLabel?: string;
  timeTitle?: string;
  statusLabel?: React.ReactNode;
  beforeContent?: React.ReactNode;
  afterContent?: React.ReactNode;
  hideQuote?: boolean;
  renderAssistant?: (message: Message) => React.ReactNode;
  renderUser?: (message: Message) => React.ReactNode;
};

export function ConversationMessage({ message, variant = "main", className: extraClassName, avatar, avatarClassName, name, timeLabel, timeTitle, statusLabel, beforeContent, afterContent, hideQuote, renderAssistant, renderUser }: ConversationMessageProps) {
  const reader = variant === "reader";
  const className = `${reader ? "reader-ask-message " : ""}message ${message.role}`;
  const messageName = name ?? (message.role === "assistant" ? "Codex Web" : message.role === "user" ? "你" : "系统");
  const time = timeLabel ?? (message.created_at ? new Date(message.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "");
  const content = <>
      {beforeContent}
      {!hideQuote && message.quote_excerpt && <ConversationQuote excerpt={message.quote_excerpt} label="引用" className="message-reference" />}
      {message.content && (message.role === "assistant" ? renderAssistant?.(message) ?? <ConversationMarkdown content={message.content} className={reader ? "reader-ask-markdown markdown" : "assistant-markdown markdown"} /> : renderUser?.(message) ?? <p data-agent-selectable="true">{message.content}</p>)}
      {afterContent}
  </>;
  return <article className={`${className} ${extraClassName ?? ""}`.trim()} data-message-id={message.id}>
    <div className={`message-avatar ${avatarClassName ?? ""}`.trim()}>{avatar ?? (message.role === "assistant" ? <Zap size={15} /> : messageName.slice(0, 2))}</div>
    <div className="message-body">
      <div className="message-meta"><span className="message-name">{messageName}</span>{statusLabel && <span className="live-label">{statusLabel}</span>}<time dateTime={message.created_at} title={timeTitle}>{time}</time></div>
      {content}
    </div>
  </article>;
}

export function ConversationMessageList({ messages, variant = "main", loading, loadingLabel = "正在加载会话上下文…", emptyLabel, pendingQuestion, pendingLabel, streamingContent, progressLabel, onScroll, className, style, containerRef, renderAssistant, renderUser, messageProps, userAvatar, assistantAvatar, beforeMessages, afterMessages }: {
  messages: Message[];
  variant?: ConversationMessageVariant;
  loading?: boolean;
  loadingLabel?: string;
  emptyLabel?: React.ReactNode;
  pendingQuestion?: string;
  pendingLabel?: React.ReactNode;
  streamingContent?: string;
  progressLabel?: string;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  className?: string;
  style?: React.CSSProperties;
  containerRef?: React.RefObject<HTMLDivElement | null>;
  renderAssistant?: (message: Message) => React.ReactNode;
  renderUser?: (message: Message) => React.ReactNode;
  messageProps?: (message: Message) => Omit<ConversationMessageProps, "message" | "variant">;
  userAvatar?: React.ReactNode;
  assistantAvatar?: React.ReactNode;
  beforeMessages?: React.ReactNode;
  afterMessages?: React.ReactNode;
}) {
  const reader = variant === "reader";
  return <div ref={containerRef} className={className} style={style} onScroll={onScroll}>
    {loading && <div className={reader ? "reader-ask-history-loading" : "history-loader"}><LoaderCircle className="spin" size={reader ? 16 : 14} /><span>{loadingLabel}</span></div>}
    {!loading && messages.length === 0 && emptyLabel}
    {beforeMessages}
    {messages.map((message) => <ConversationMessage key={message.id} message={message} variant={variant} renderAssistant={renderAssistant} renderUser={renderUser} {...messageProps?.(message)} />)}
    {pendingQuestion && <ConversationMessage message={{ id: "pending-question", role: "user", content: pendingQuestion, quote_excerpt: null, attachment_references: [], created_at: new Date().toISOString(), files: [] }} variant={variant} className="pending" avatar={userAvatar} statusLabel={pendingLabel} timeLabel={pendingLabel ? "" : undefined} />}
    {streamingContent && <article className={`${reader ? "reader-ask-message " : ""}message assistant running streaming`}><div className="message-avatar">{assistantAvatar ?? <Zap size={15} />}</div><div className="message-body"><div className="message-meta"><span className="message-name">Codex Web</span><span className="live-label"><LoaderCircle className="spin" size={12} />正在生成</span></div><ConversationMarkdown content={streamingContent} className={reader ? "reader-ask-markdown markdown" : "assistant-markdown markdown"} /></div></article>}
    {progressLabel && <div className={reader ? "reader-ask-progress" : "conversation-progress"}><LoaderCircle className="spin" size={14} /><span>{progressLabel}</span></div>}
    {afterMessages}
  </div>;
}
