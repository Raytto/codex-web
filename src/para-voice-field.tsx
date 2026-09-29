import { useId, useRef } from "react";
import { LoaderCircle, Mic } from "lucide-react";
import { ConversationVoicePanel } from "./conversation/ConversationVoiceInput";
import { useVoiceInput, type VoiceInputController } from "./conversation/useVoiceInput";

export function useParaVoiceInput({ accountId, scope, value, onChange, disabled }: {
  accountId: string;
  scope: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  // Recording keeps its original context, but its result must append to the
  // latest editor value, including typing while the microphone was active.
  const editor = useRef({ value, onChange });
  editor.current = { value, onChange };
  return useVoiceInput({
    accountId,
    persistDraft: true,
    draftScope: scope,
    draftText: value,
    disabled,
    maxDurationMs: 10 * 60 * 1000,
    fileNamePrefix: "para-recording",
    onTranscript: (text) => {
      const current = editor.current;
      const combined = current.value ? `${current.value}${/\s$/.test(current.value) ? "" : "\n"}${text}` : text;
      current.onChange(combined);
    },
  });
}

export function paraVoiceBusy(voice: VoiceInputController) {
  return voice.starting || voice.state !== "idle" || voice.draftRestoring || Boolean(voice.pendingDraft);
}

export function ParaVoiceField({ label, value, onChange, voice, disabled, placeholder, maxLength, rows = 2, required = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  voice: VoiceInputController;
  disabled: boolean;
  placeholder: string;
  maxLength: number;
  rows?: number;
  required?: boolean;
}) {
  const id = useId();
  const tooLong = value.length > maxLength;
  return <div className="para-voice-field">
    <div className="para-voice-heading">
      <label htmlFor={id}>{label}</label>
      {maxLength <= 180 && <span className={tooLong ? "para-voice-limit" : undefined}>{value.length} / {maxLength}</span>}
    </div>
    <div className={`para-voice-composer ${voice.state}`}>
      <textarea id={id} autoFocus rows={rows} required={required} maxLength={maxLength}
        value={value} onChange={(event) => onChange(event.target.value)}
        placeholder={voice.state === "recording" ? "正在录音，也可以继续输入文字…" : placeholder}
        disabled={disabled || voice.state === "transcribing"} aria-invalid={tooLong}
        aria-describedby={tooLong ? `${id}-limit` : undefined} />
      {voice.state === "idle" && <button type="button" className="para-voice-mic"
        onClick={() => void voice.start()} disabled={disabled || paraVoiceBusy(voice)}
        aria-label={voice.starting ? "正在开启麦克风" : "语音输入"} title="语音输入">
        {voice.starting ? <LoaderCircle size={19} className="spin" /> : <Mic size={20} />}
      </button>}
      <ConversationVoicePanel voice={voice} />
    </div>
    {tooLong && <p className="para-voice-limit" id={`${id}-limit`} role="alert">文字已保留，请精简到 {maxLength} 字以内再保存。</p>}
  </div>;
}
