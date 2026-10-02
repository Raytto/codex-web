import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export type SettingMenuOption = { id: string; label: string; description?: string; indicator?: ReactNode };

export function SettingMenu({ menuId: menuIdProp, className, label, ariaLabel, floating = false, value, options, placeholder, title, disabled, open, onOpenIntent, onOpenIntentCancel, onOpenChange, onChange }: {
  menuId?: string;
  className: string;
  label: string;
  ariaLabel?: string;
  floating?: boolean;
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
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options.find((option) => option.id === value);
  const menuId = menuIdProp ?? `setting-menu-${className}`;

  useLayoutEffect(() => {
    if (!open || !floating || !rootRef.current || !panelRef.current) return;
    const anchor = rootRef.current.getBoundingClientRect();
    const panel = panelRef.current.getBoundingClientRect();
    const below = anchor.bottom + 6;
    setPosition({
      top: Math.max(8, below + panel.height <= window.innerHeight - 8 ? below : anchor.top - panel.height - 6),
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - panel.width - 8)),
    });
  }, [floating, open, options.length]);

  useEffect(() => {
    if (open && (disabled || options.length === 0)) onOpenChange(false);
  }, [disabled, onOpenChange, open, options.length]);
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);
  useEffect(() => {
    if (!open) return;
    const anchorAtOpen = rootRef.current?.getBoundingClientRect();
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) onOpenChange(false);
    }
    function closeWhenMoved(event: Event) {
      if (!floating || panelRef.current?.contains(event.target as Node)) return;
      // Focusing a trigger can scroll it before the menu opens. Browsers may
      // deliver that scroll event afterward; keep the correctly placed menu.
      const anchor = rootRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      const moved = !anchor || !anchorAtOpen ||
        Math.abs(anchor.top - anchorAtOpen.top) > 1 ||
        Math.abs(anchor.left - anchorAtOpen.left) > 1 ||
        Math.abs(anchor.bottom - anchorAtOpen.bottom) > 1 ||
        Math.abs(anchor.right - anchorAtOpen.right) > 1;
      const clipped = panel && (panel.right > window.innerWidth || panel.bottom > window.innerHeight);
      if (moved || clipped) onOpenChange(false);
    }
    window.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("resize", closeWhenMoved);
    window.addEventListener("scroll", closeWhenMoved, true);
    return () => {
      window.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("resize", closeWhenMoved);
      window.removeEventListener("scroll", closeWhenMoved, true);
    };
  }, [floating, onOpenChange, open]);

  function choose(option: SettingMenuOption) {
    if (option.id !== value) onChange(option.id);
    onOpenChange(false);
    triggerRef.current?.focus();
  }

  function keyDown(event: React.KeyboardEvent<HTMLElement>) {
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
      triggerRef.current?.focus();
    }
    if (event.key === "Tab") onOpenChange(false);
  }

  const panel = open && <div ref={panelRef} id={menuId} className={`setting-menu-panel${floating ? " floating-setting-menu" : ""}`} role="listbox" aria-label={ariaLabel ?? label}
    style={floating ? position : undefined} onKeyDown={keyDown}>
    {options.map((option, index) => <button key={option.id} type="button" role="option" aria-selected={option.id === value} className={`${option.id === value ? "selected" : ""} ${index === activeIndex ? "active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option)}>
      <span><strong className={option.indicator ? "setting-option-marked" : undefined}>{option.indicator}{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.id === value && <Check size={14} />}
    </button>)}
  </div>;
  return <div ref={rootRef} className={`setting-menu ${className}`}>
    <button ref={triggerRef} type="button" className="setting-select" aria-label={ariaLabel ?? label} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} disabled={disabled} title={title} onPointerDown={onOpenIntent} onPointerCancel={onOpenIntentCancel} onClick={() => { onOpenIntentCancel(); onOpenChange(!open); }} onKeyDown={keyDown}>
      {label && <span>{label}</span>}<strong className="setting-value">{selected?.indicator}{(selected?.label ?? value) || placeholder}</strong><ChevronDown size={13} />
    </button>
    {floating ? createPortal(panel, document.body) : panel}
  </div>;
}
