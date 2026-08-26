import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export type SettingMenuOption = { id: string; label: string; description?: string };

export function SettingMenu({ menuId: menuIdProp, className, label, value, options, placeholder, title, disabled, open, onOpenIntent, onOpenIntentCancel, onOpenChange, onChange }: {
  menuId?: string;
  className: string;
  label: string;
  value: string;
  options: SettingMenuOption[];
  placeholder: string;
  title: string;
  disabled: boolean;
  open: boolean;
  onOpenIntent: () => void;
  onOpenIntentCancel: () => void;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options.find((option) => option.id === value);
  const menuId = menuIdProp ?? `setting-menu-${className}`;

  useEffect(() => {
    if (open && (disabled || options.length === 0)) onOpenChange(false);
  }, [disabled, onOpenChange, open, options.length]);
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);
  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    }
    window.addEventListener("pointerdown", closeFromOutside);
    return () => window.removeEventListener("pointerdown", closeFromOutside);
  }, [onOpenChange, open]);

  function choose(option: SettingMenuOption) {
    if (option.id !== value) onChange(option.id);
    onOpenChange(false);
  }

  function keyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled || options.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) onOpenChange(true);
      else setActiveIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open && options[activeIndex]) choose(options[activeIndex]);
      else onOpenChange(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
    }
  }

  return <div ref={rootRef} className={`setting-menu ${className}`}>
    <button type="button" className="setting-select" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} disabled={disabled} title={title} onPointerDown={onOpenIntent} onPointerCancel={onOpenIntentCancel} onClick={() => { onOpenIntentCancel(); onOpenChange(!open); }} onKeyDown={keyDown}>
      <span>{label}</span><strong className="setting-value">{(selected?.label ?? value) || placeholder}</strong><ChevronDown size={13} />
    </button>
    {open && <div id={menuId} className="setting-menu-panel" role="listbox" aria-label={label}>
      {options.map((option, index) => <button key={option.id} type="button" role="option" aria-selected={option.id === value} className={`${option.id === value ? "selected" : ""} ${index === activeIndex ? "active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option)}>
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.id === value && <Check size={14} />}
      </button>)}
    </div>}
  </div>;
}
