import { useRef, useState } from "react";
import { ArrowUp, CornerUpLeft, File as FileIcon, FileText, LoaderCircle, Paperclip, Square, X } from "lucide-react";
import type { AgentOptions, ReasoningEffort } from "../api";
import { ConversationVoiceInput } from "./ConversationVoiceInput";
import { SettingMenu } from "./SettingMenu";
import type { ConversationVoiceState } from "./conversation-types";

export type ConversationComposerProps = {
  conversationId?: string | null;
  value: string;
  quote?: string;
  /** A typed reference shared by the main and reader composers. `quote` remains
   * accepted for callers that only have an excerpt; `reference` wins when both
   * are supplied. */
  reference?: ComposerReference;
  files: File[];
  model: string;
  reasoningEffort: ReasoningEffort | "";
  agentOptions: AgentOptions | null;
  disabled?: boolean;
  submitting?: boolean;
  canSend: boolean;
  placeholder?: string;
  className?: string;
  controlsClassName?: string;
  attachmentClassName?: string;
  sendClassName?: string;
  voiceClassName?: string;
  voicePanelClassName?: string;
  voiceControlClassName?: string;
  voiceMicClassName?: string;
  maxFiles?: number;
  attachmentNames?: string[];
  onChange: (value: string) => void;
  onQuoteRemove?: () => void;
  onFilesChange: (files: File[]) => void;
  onModelChange: (model: string) => void;
  onReasoningChange: (effort: ReasoningEffort) => void;
  onSend: () => void;
  onStop?: () => void;
  onTranscript: (text: string, transcriptionId: string) => void;
  onVoiceStateChange?: (state: ConversationVoiceState) => void;
  onSendAfterTranscription?: (text: string, transcriptionIds: string[]) => void;
};

export type ComposerReferenceKind = "conversation" | "file";

export type ComposerReference = {
  excerpt: string;
  kind?: ComposerReferenceKind;
  /** Optional short label shown before the excerpt, e.g. “文件引用”. */
  label?: string;
  /** Accessible/hover title. Defaults to the excerpt. */
  title?: string;
};

/**
 * The compact reference card is deliberately shared with the main Composer.
 * Keeping this primitive independent of the send implementation lets the
 * reader add file context without creating a second visual language.
 */
export function ConversationComposerReference({ reference, onRemove, className }: {
  reference: ComposerReference;
  onRemove?: () => void;
  className?: string;
}) {
  const label = reference.label?.trim();
  const title = reference.title?.trim() || reference.excerpt || label || "当前引用";
  const classes = ["ask-agent-reference", className].filter(Boolean).join(" ");
  return <div className={classes} title={title} data-reference-kind={reference.kind ?? "conversation"}>
    {reference.kind === "file" ? <FileText size={15} /> : <CornerUpLeft size={15} />}
    <span>{label && <strong>{label}</strong>}{reference.excerpt || "当前没有引用，请返回正文重新选择"}</span>
    {onRemove && <button type="button" onClick={onRemove} aria-label="移除引用" title="移除引用"><X size={14} /></button>}
  </div>;
}

export function ConversationComposer({ conversationId, value, quote, reference, files, model, reasoningEffort, agentOptions, disabled, submitting, canSend, placeholder = "输入你想问的问题…", className, controlsClassName, attachmentClassName, sendClassName, voiceClassName, voicePanelClassName, voiceControlClassName, voiceMicClassName, maxFiles = 10, attachmentNames, onChange, onQuoteRemove, onFilesChange, onModelChange, onReasoningChange, onSend, onStop, onTranscript, onVoiceStateChange, onSendAfterTranscription }: ConversationComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [openMenu, setOpenMenu] = useState<"model" | "effort" | null>(null);
  const selectedModel = agentOptions?.models.find((candidate) => candidate.id === model);
  const effortOptions = agentOptions?.reasoningEfforts.filter((effort) => selectedModel?.reasoningEfforts.includes(effort.id)) ?? [];
  const addFiles = (newFiles: File[]) => onFilesChange([...files, ...newFiles].slice(-maxFiles));
  const composerReference = reference ?? (quote?.trim() ? { excerpt: quote } : undefined);
  return <div className={`conversation-composer composer expanded ${className ?? ""}`}>
    {composerReference !== undefined && <ConversationComposerReference reference={composerReference} onRemove={onQuoteRemove} className={className?.includes("reader-ask") ? "reader-ask-reference" : undefined} />}
    {files.length > 0 && <div className={`pending-files ${className?.includes("reader-ask") ? "reader-ask-files" : ""}`}>{files.map((file, index) => <span key={`${file.name}-${index}`}><FileIcon size={14} /><span className="attachment-chip-name">{file.name}</span><button type="button" onClick={() => onFilesChange(files.filter((_, fileIndex) => fileIndex !== index))} aria-label={`移除附件 ${file.name}`} title="移除附件"><X size={13} /></button></span>)}</div>}
    <textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={placeholder} rows={2} disabled={disabled || submitting} />
    <div className={`composer-actions conversation-composer-actions ${controlsClassName ?? ""}`}>
      <div className={`composer-primary-actions ${controlsClassName?.includes("reader-ask") ? "reader-ask-controls" : ""}`}>
        <button type="button" className={`attach-button ${attachmentClassName ?? ""}`} onClick={() => fileInputRef.current?.click()} disabled={disabled || submitting} title="添加文件" aria-label="添加文件"><Paperclip size={17} /><span>添加文件</span></button>
        <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
        <SettingMenu className="model" label="模型" value={model} options={agentOptions?.models.map((option) => ({ id: option.id, label: option.label, description: option.description })) ?? []} placeholder="加载中" title={selectedModel?.description || "选择任务使用的模型"} disabled={Boolean(!agentOptions || disabled || submitting)} open={openMenu === "model"} onOpenIntent={() => undefined} onOpenIntentCancel={() => undefined} onOpenChange={(open) => setOpenMenu(open ? "model" : openMenu === "model" ? null : openMenu)} onChange={onModelChange} />
        <SettingMenu className="effort" label="思考" value={reasoningEffort} options={effortOptions} placeholder="加载中" title="选择模型的思考深度" disabled={Boolean(!selectedModel || disabled || submitting)} open={openMenu === "effort"} onOpenIntent={() => undefined} onOpenIntentCancel={() => undefined} onOpenChange={(open) => setOpenMenu(open ? "effort" : openMenu === "effort" ? null : openMenu)} onChange={onReasoningChange} />
      </div>
      <ConversationVoiceInput conversationId={conversationId} draftText={value} attachmentNames={attachmentNames ?? files.map((file) => file.name)} disabled={disabled || submitting} className={voiceClassName} panelClassName={voicePanelClassName} controlClassName={voiceControlClassName} micClassName={voiceMicClassName} onStateChange={onVoiceStateChange} onTranscript={onTranscript} onSendAfterTranscription={onSendAfterTranscription} />
      {submitting && onStop
        ? <button type="button" className={`send-button stop conversation-send-button ${sendClassName ?? ""}`} onClick={onStop} aria-label="停止当前任务" title="停止当前任务"><Square size={15} fill="currentColor" /></button>
        : <button type="button" className={`send-button conversation-send-button ${sendClassName ?? ""}`} onClick={onSend} disabled={disabled || submitting || !canSend} aria-label="发送" title="发送">{submitting ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}</button>}
    </div>
  </div>;
}
