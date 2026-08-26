import { useEffect } from "react";
import { Check, LoaderCircle, Mic, Square, X } from "lucide-react";
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
      {voice.notice && <span className="voice-notice" role="status" aria-live="polite"><Check size={13} />{voice.notice}</span>}
      {voice.error && <span className={`voice-error ${readerVariant ? "reader-ask-error" : ""}`} role="alert"><span>{voice.error}</span><button type="button" onClick={voice.clearError} aria-label="关闭语音错误"><X size={13} /></button></span>}
      {state === "idle" && onStart && <button type="button" className={`mic-button ${micClassName ?? ""} ${className ?? ""}`} onClick={onStart} disabled={micDisabled} aria-label="语音输入" title="语音输入"><Mic size={18} /></button>}
    </div>
  </>;
}

export function ConversationVoiceInput({ onStateChange, className, panelClassName, controlClassName, micClassName, compact, ...options }: ConversationVoiceInputProps) {
  const voice = useVoiceInput({ ...options, onTranscript: options.onTranscript, onSendAfterTranscription: options.onSendAfterTranscription });
  return <ConversationVoicePanel voice={voice} className={className} panelClassName={panelClassName} controlClassName={controlClassName} micClassName={micClassName} compact={compact} micDisabled={options.disabled} onStart={() => void voice.start()} onStateChange={onStateChange} />;
}
