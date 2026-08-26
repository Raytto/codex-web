import { useEffect } from "react";
import { Check, LoaderCircle, Mic, RefreshCw, Square, Trash2, X } from "lucide-react";
import { useVoiceInput, formatVoiceDuration, type UseVoiceInputOptions } from "./useVoiceInput";
import type { ConversationVoiceState } from "./conversation-types";

export type ConversationVoiceInputProps = Omit<UseVoiceInputOptions, "onTranscript" | "onSendAfterTranscription"> & {
  onTranscript: NonNullable<UseVoiceInputOptions["onTranscript"]>;
  onSendAfterTranscription?: UseVoiceInputOptions["onSendAfterTranscription"];
  onStateChange?: (state: ConversationVoiceState) => void;
  className?: string;
  panelClassName?: string;
  controlClassName?: string;
  micClassName?: string;
  compact?: boolean;
};

export function ConversationVoicePanel({ voice, className, panelClassName, controlClassName, micClassName, compact, micDisabled, onStart, onStateChange }: {
  voice: ReturnType<typeof useVoiceInput>;
  className?: string;
  panelClassName?: string;
  controlClassName?: string;
  micClassName?: string;
  compact?: boolean;
  micDisabled?: boolean;
  onStart?: () => void;
  onStateChange?: (state: ConversationVoiceState) => void;
}) {
  const state = voice.state;
  const readerVariant = [className, panelClassName, controlClassName, micClassName].some((value) => value?.includes("reader-ask"));
  useEffect(() => { onStateChange?.(state); }, [onStateChange, state]);
  return <>
    {state !== "idle" && <div className={`voice-panel ${compact ? "conversation-voice-panel" : ""} ${className ?? ""} ${panelClassName ?? ""} ${state}`}>
      {state === "recording" ? <>
        <button type="button" className="voice-cancel" onClick={voice.cancel} aria-label="取消录音" title="取消录音"><X size={15} /></button>
        <canvas ref={voice.waveformRef} aria-label="实时音量波形" />
        <time>{formatVoiceDuration(voice.elapsed)}</time>
        <button type="button" className="voice-stop" onClick={() => voice.finish(false)} aria-label="停止录音并识别" title="停止并转成文字"><Square size={12} fill="currentColor" /></button>
      </> : <><LoaderCircle className="spin" size={17} /><span>正在识别语音…</span></>}
    </div>}
    <div className={`conversation-voice-wrap ${className ?? ""} ${controlClassName ?? ""}`}>
      {voice.draftRestoring && <span className="voice-draft-restoring" role="status" aria-live="polite"><LoaderCircle className="spin" size={13} />正在恢复未发送语音…</span>}
      {voice.pendingDraft && state === "idle" && <div className="voice-retry-card" role="status" aria-live="polite">
        <Mic size={15} />
        <span className="voice-retry-copy"><strong>语音未发送，音频已保留</strong><small>{voice.pendingDraft.lastError || "可以重试识别，或删除这段录音。"}</small></span>
        <button type="button" onClick={voice.retryPending} aria-label="重试识别语音" title="重试识别语音"><RefreshCw size={14} />重试</button>
        <button type="button" onClick={voice.discardPending} aria-label="删除保留的语音" title="删除保留的语音"><Trash2 size={14} /></button>
      </div>}
      {voice.draftStorageError && <span className="voice-draft-storage-error" role="alert">{voice.draftStorageError}</span>}
      {voice.notice && <span className="voice-notice" role="status" aria-live="polite"><Check size={13} />{voice.notice}</span>}
      {voice.error && <span className={`voice-error ${readerVariant ? "reader-ask-error" : ""}`} role="alert"><span>{voice.error}</span><button type="button" onClick={voice.clearError} aria-label="关闭语音错误"><X size={13} /></button></span>}
      {state === "idle" && onStart && !voice.pendingDraft && !voice.draftRestoring && <button type="button" className={`mic-button ${micClassName ?? ""} ${className ?? ""}`} onClick={onStart} disabled={micDisabled} aria-label="语音输入" title="语音输入"><Mic size={18} /></button>}
    </div>
  </>;
}

export function ConversationVoiceInput({ onStateChange, className, panelClassName, controlClassName, micClassName, compact, ...options }: ConversationVoiceInputProps) {
  const voice = useVoiceInput({ ...options, onTranscript: options.onTranscript, onSendAfterTranscription: options.onSendAfterTranscription });
  return <ConversationVoicePanel voice={voice} className={className} panelClassName={panelClassName} controlClassName={controlClassName} micClassName={micClassName} compact={compact} micDisabled={options.disabled} onStart={() => void voice.start()} onStateChange={onStateChange} />;
}
