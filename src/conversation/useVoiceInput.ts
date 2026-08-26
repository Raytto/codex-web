import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { api } from "../api";
import type { ConversationVoiceState } from "./conversation-types";

export type UseVoiceInputOptions = {
  conversationId?: string | null;
  draftText: string;
  quoteExcerpt?: string;
  attachmentNames?: string[];
  disabled?: boolean;
  maxDurationMs?: number;
  fileNamePrefix?: string;
  unsupportedMessage?: string;
  onTranscript?: (text: string, transcriptionId: string, context?: VoiceInputContext) => void;
  onSendAfterTranscription?: (text: string, transcriptionIds: string[], context?: VoiceInputContext) => void;
};

export type VoiceInputContext = {
  conversationId: string | null;
  draftText: string;
  quoteExcerpt: string;
  attachmentNames: string[];
};

export type VoiceInputController = {
  state: ConversationVoiceState;
  elapsed: number;
  error: string;
  notice: string;
  transcriptionIds: string[];
  transcriptionConversationId: string | null;
  waveformRef: RefObject<HTMLCanvasElement | null>;
  start: () => Promise<void>;
  finish: (sendAfterTranscription?: boolean) => void;
  cancel: () => void;
  clearError: () => void;
  clearNotice: () => void;
  clearTranscriptionIds: () => void;
};

type AudioContextWindow = Window & { webkitAudioContext?: typeof AudioContext };

function appendTranscript(existing: string, transcript: string): string {
  return existing ? `${existing}${/\s$/.test(existing) ? "" : "\n"}${transcript}` : transcript;
}

function fileExtension(mimeType: string): string {
  return mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : "webm";
}

export function formatVoiceDuration(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function useVoiceInput(options: UseVoiceInputOptions): VoiceInputController {
  const [state, setState] = useState<ConversationVoiceState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [transcriptionIds, setTranscriptionIds] = useState<string[]>([]);
  const [transcriptionConversationId, setTranscriptionConversationId] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const limitTimerRef = useRef<number | null>(null);
  const discardRef = useRef(false);
  const sendAfterRef = useRef(false);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);
  const draftTextRef = useRef(options.draftText);
  const quoteExcerptRef = useRef(options.quoteExcerpt ?? "");
  const attachmentNamesRef = useRef(options.attachmentNames ?? []);
  const optionsRef = useRef(options);
  const sessionRef = useRef<VoiceInputContext | null>(null);
  const sessionCallbacksRef = useRef<Pick<UseVoiceInputOptions, "onTranscript" | "onSendAfterTranscription"> | null>(null);
  const transcriptionIdsRef = useRef<string[]>([]);
  const transcriptionConversationIdRef = useRef<string | null>(null);
  draftTextRef.current = options.draftText;
  quoteExcerptRef.current = options.quoteExcerpt ?? "";
  attachmentNamesRef.current = options.attachmentNames ?? [];
  optionsRef.current = options;

  const release = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    if (limitTimerRef.current !== null) window.clearTimeout(limitTimerRef.current);
    if (animationRef.current !== null) window.cancelAnimationFrame(animationRef.current);
    timerRef.current = null;
    limitTimerRef.current = null;
    animationRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    analyserRef.current = null;
    if (context) void context.close().catch(() => undefined);
  }, []);

  const changeState = useCallback((next: ConversationVoiceState) => setState(next), []);

  const drawWaveform = useCallback((analyser: AnalyserNode) => {
    const canvas = waveformRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const values = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(values);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#4b5794";
    const bars = 36;
    const gap = 2 * dpr;
    const barWidth = Math.max(2 * dpr, (width - gap * (bars - 1)) / bars);
    for (let index = 0; index < bars; index += 1) {
      const value = values[Math.min(values.length - 1, Math.floor(index * values.length / bars))] ?? 0;
      const barHeight = Math.max(3 * dpr, (value / 255) * height * .86);
      const x = index * (barWidth + gap);
      const y = (height - barHeight) / 2;
      context.beginPath();
      context.roundRect(x, y, barWidth, barHeight, barWidth / 2);
      context.fill();
    }
    animationRef.current = window.requestAnimationFrame(() => drawWaveform(analyser));
  }, []);

  const process = useCallback(async (mimeType: string) => {
    release();
    recorderRef.current = null;
    if (discardRef.current) { chunksRef.current = []; sessionRef.current = null; sessionCallbacksRef.current = null; return; }
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    if (blob.size === 0) {
      setNotice("");
      setError("没有录到声音，请重试。");
      changeState("idle");
      setElapsed(0);
      sessionRef.current = null;
      sessionCallbacksRef.current = null;
      return;
    }
    const current = optionsRef.current;
    const session = sessionRef.current ?? {
      conversationId: current.conversationId ?? null,
      draftText: draftTextRef.current,
      quoteExcerpt: quoteExcerptRef.current,
      attachmentNames: attachmentNamesRef.current.slice(0, 12),
    };
    try {
      const result = await api.transcribeAudio(blob, `${current.fileNamePrefix ?? "recording"}.${fileExtension(mimeType)}`, {
        conversationId: session.conversationId ?? undefined,
        draftText: session.draftText,
        attachmentNames: session.attachmentNames,
      });
      const nextIds = [...transcriptionIdsRef.current, result.transcriptionId].slice(-20);
      transcriptionIdsRef.current = nextIds;
      setTranscriptionIds(nextIds);
      transcriptionConversationIdRef.current = session.conversationId;
      setTranscriptionConversationId(session.conversationId);
      const text = appendTranscript(session.draftText, result.text);
      sessionCallbacksRef.current?.onTranscript?.(result.text, result.transcriptionId, session);
      if (sendAfterRef.current) sessionCallbacksRef.current?.onSendAfterTranscription?.(text, nextIds, session);
      sendAfterRef.current = false;
      sessionRef.current = null;
      sessionCallbacksRef.current = null;
      setNotice("");
      setError("");
      changeState("idle");
      setElapsed(0);
    } catch (reason) {
      sendAfterRef.current = false;
      setNotice("");
      setError(reason instanceof Error ? reason.message : "语音识别失败，请重试。");
      changeState("idle");
      sessionRef.current = null;
      sessionCallbacksRef.current = null;
    }
  }, [changeState, release]);

  const start = useCallback(async () => {
    const current = optionsRef.current;
    if (current.disabled || state !== "idle") return;
    setError("");
    setNotice("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError(current.unsupportedMessage ?? "当前浏览器不支持录音。");
      return;
    }
    try {
      const targetConversationId = current.conversationId ?? null;
      if (transcriptionConversationIdRef.current !== targetConversationId) {
        transcriptionIdsRef.current = [];
        setTranscriptionIds([]);
        transcriptionConversationIdRef.current = targetConversationId;
        setTranscriptionConversationId(targetConversationId);
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
      const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      discardRef.current = false;
      sendAfterRef.current = false;
      sessionRef.current = {
        conversationId: current.conversationId ?? null,
        draftText: current.draftText,
        quoteExcerpt: current.quoteExcerpt ?? "",
        attachmentNames: (current.attachmentNames ?? []).slice(0, 12),
      };
      sessionCallbacksRef.current = {
        onTranscript: current.onTranscript,
        onSendAfterTranscription: current.onSendAfterTranscription,
      };
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onerror = () => {
        discardRef.current = true;
        setError("录音中断，请检查麦克风权限后重试。");
        if (recorder.state === "recording") recorder.stop();
        release();
        sessionRef.current = null;
        sessionCallbacksRef.current = null;
        changeState("idle");
      };
      recorder.onstop = () => void process(recorder.mimeType || mimeType || "audio/webm");
      recorder.start(250);
      setElapsed(0);
      changeState("recording");
      const AudioContextCtor = window.AudioContext || (window as AudioContextWindow).webkitAudioContext;
      if (AudioContextCtor) {
        try {
          const context = new AudioContextCtor();
          const analyser = context.createAnalyser();
          analyser.fftSize = 128;
          analyser.smoothingTimeConstant = .76;
          context.createMediaStreamSource(stream).connect(analyser);
          audioContextRef.current = context;
          analyserRef.current = analyser;
        } catch { /* Waveform is decorative; recording continues without it. */ }
      }
      const startedAt = Date.now();
      timerRef.current = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
      if (current.maxDurationMs && current.maxDurationMs > 0) {
        limitTimerRef.current = window.setTimeout(() => {
          if (recorder.state !== "recording") return;
          sendAfterRef.current = false;
          setNotice(current.maxDurationMs === 5 * 60 * 1000 ? "已达到 5 分钟录音上限，正在识别…" : "已达到录音上限，正在识别…");
          recorder.stop();
          changeState("transcribing");
        }, current.maxDurationMs);
      }
    } catch (reason) {
      release();
      changeState("idle");
      const denied = reason instanceof DOMException && ["NotAllowedError", "PermissionDeniedError"].includes(reason.name);
      setError(denied ? "请允许浏览器使用麦克风，然后再试一次。" : "无法开始录音，请检查麦克风。");
    }
  }, [changeState, drawWaveform, process, release, state]);

  // The recording state controls whether the canvas exists. Start drawing only
  // after React has committed that state so the shared panel can actually bind
  // the canvas; calling drawWaveform immediately after setState races the mount
  // and silently leaves both composers with an empty waveform.
  useEffect(() => {
    if (state !== "recording" || !analyserRef.current) return;
    drawWaveform(analyserRef.current);
    return () => {
      if (animationRef.current !== null) window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    };
  }, [drawWaveform, state]);

  const finish = useCallback((sendAfterTranscription = false) => {
    if (state !== "recording" || recorderRef.current?.state !== "recording") return;
    sendAfterRef.current = sendAfterTranscription;
    recorderRef.current.stop();
    changeState("transcribing");
  }, [changeState, state]);

  const cancel = useCallback(() => {
    if (state !== "recording") return;
    discardRef.current = true;
    sendAfterRef.current = false;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    release();
    sessionRef.current = null;
    sessionCallbacksRef.current = null;
    changeState("idle");
    setElapsed(0);
    setNotice("");
  }, [changeState, release, state]);

  const clearTranscriptionIds = useCallback(() => {
    transcriptionIdsRef.current = [];
    setTranscriptionIds([]);
    transcriptionConversationIdRef.current = null;
    setTranscriptionConversationId(null);
  }, []);

  useEffect(() => () => {
    discardRef.current = true;
    sendAfterRef.current = false;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    release();
  }, [release]);

  return {
    state,
    elapsed,
    error,
    notice,
    transcriptionIds,
    transcriptionConversationId,
    waveformRef,
    start,
    finish,
    cancel,
    clearError: () => setError(""),
    clearNotice: () => setNotice(""),
    clearTranscriptionIds,
  };
}
