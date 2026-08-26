import { useEffect, useRef } from "react";
import { Minus, Monitor, Moon, Plus, Settings2, Sun, X } from "lucide-react";
import { CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN } from "./chat-font-size";
import type { ThemePreference } from "./theme";

type DisplaySettingsDialogProps = {
  chatFontSize: number;
  fontSizeSaving: boolean;
  onChangeFontSize: (delta: number) => void;
  themePreference: ThemePreference;
  onThemePreferenceChange: (preference: ThemePreference) => void;
  onClose: () => void;
};

export function DisplaySettingsDialog({ chatFontSize, fontSizeSaving, onChangeFontSize, themePreference, onThemePreferenceChange, onClose }: DisplaySettingsDialogProps) {
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => closeButton.current?.focus({ preventScroll: true }));
    const closeEscape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [onClose]);

  return <div className="project-dialog-backdrop display-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-dialog display-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="display-settings-dialog-title">
      <header>
        <div><Settings2 size={19} /><div><h2 id="display-settings-dialog-title">显示设置</h2><p>统一调整聊天文字和浅色、深色显示模式。</p></div></div>
        <button ref={closeButton} type="button" onClick={onClose} aria-label="关闭显示设置"><X size={18} /></button>
      </header>
      <div className="display-settings-body">
        <section className="display-settings-card">
          <div className="display-settings-card-copy"><strong>聊天正文字号</strong><small>正文、行距与内容间距同步调整</small></div>
          <div className="font-size-stepper">
            <button type="button" aria-label="减小聊天正文字号" disabled={fontSizeSaving || chatFontSize <= CHAT_FONT_SIZE_MIN} onClick={() => onChangeFontSize(-1)}><Minus size={15} /></button>
            <output aria-live="polite">{chatFontSize}px</output>
            <button type="button" aria-label="增大聊天正文字号" disabled={fontSizeSaving || chatFontSize >= CHAT_FONT_SIZE_MAX} onClick={() => onChangeFontSize(1)}><Plus size={15} /></button>
          </div>
        </section>
        <section className="display-settings-card">
          <div className="display-settings-card-copy"><strong>显示模式</strong><small>选择浅色、深色或跟随设备设置</small></div>
          <div className="display-settings-theme-options" role="group" aria-label="显示模式">
            <button type="button" aria-label="使用浅色模式" aria-pressed={themePreference === "light"} onClick={() => onThemePreferenceChange("light")}><Sun size={16} /><span>浅色</span></button>
            <button type="button" aria-label="使用深色模式" aria-pressed={themePreference === "dark"} onClick={() => onThemePreferenceChange("dark")}><Moon size={16} /><span>深色</span></button>
            <button type="button" aria-label="外观跟随系统" aria-pressed={themePreference === "system"} onClick={() => onThemePreferenceChange("system")}><Monitor size={16} /><span>系统</span></button>
          </div>
        </section>
      </div>
    </section>
  </div>;
}
