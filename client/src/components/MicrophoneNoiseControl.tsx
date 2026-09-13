import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { MicrophoneNoiseMode } from "../microphoneCandidate";

const NOISE_MODES: ReadonlyArray<{ value: MicrophoneNoiseMode; label: string }> =
  [
    { value: "system", label: "系统降噪（默认）" },
    { value: "rnnoise", label: "RNNoise（实验）" },
  ];

const MENU_GAP = 6;

/**
 * 麦克风降噪模式选择。
 *
 * 这里不用原生 <select>：它的弹出列表由系统绘制，既跟随不了 Cove 主题，也和
 * 其余浮层的圆角、阴影、选中态完全不是一套语言。改用「按钮 + 浮层菜单」，
 * 菜单挂在 body 上，避免被设置页的滚动容器裁掉。
 */
export function MicrophoneNoiseControl({
  mode,
  busy,
  disabled,
  error,
  onChange,
}: {
  mode: MicrophoneNoiseMode;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onChange: (mode: MicrophoneNoiseMode) => void;
}) {
  const labelId = useId();
  const valueId = useId();
  const [open, setOpen] = useState(false);
  const [positioned, setPositioned] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const blocked = disabled || busy;
  const selectedLabel =
    NOISE_MODES.find((option) => option.value === mode)?.label ?? mode;

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const height = menuRef.current?.offsetHeight ?? 0;
    const below = window.innerHeight - rect.bottom - MENU_GAP;
    // 下方放不下就翻到上方，两边都放不下时贴住空间更大的一侧。
    const flip = height > below && rect.top - MENU_GAP > below;
    setMenuStyle({
      left: rect.left,
      width: rect.width,
      top: flip ? rect.top - MENU_GAP - height : rect.bottom + MENU_GAP,
    });
    setPositioned(true);
  }, []);

  // 先量出菜单真实高度再定位，否则会在左上角闪一帧。
  useLayoutEffect(() => {
    if (!open) {
      setPositioned(false);
      return;
    }
    updateMenuPosition();
    const menu = menuRef.current;
    if (!menu) return;
    const selected = menu.querySelector<HTMLButtonElement>(
      '[role="option"][aria-selected="true"]',
    );
    (selected ?? menu.querySelector<HTMLButtonElement>('[role="option"]'))?.focus();
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updateMenuPosition();
    window.addEventListener("resize", reposition);
    // 设置页本身会滚动，菜单必须跟着字段一起走。
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target))
        return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // 切换期间控件会被禁用，菜单不能留在屏幕上。
  useEffect(() => {
    if (blocked) setOpen(false);
  }, [blocked]);

  // 模式被外部改回（例如 RNNoise 加载失败自动回退）时收起菜单。
  useEffect(() => {
    setOpen(false);
  }, [mode]);

  const focusOption = (from: number, step: number) => {
    const options =
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    if (!options?.length) return;
    options[(from + step + options.length) % options.length].focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        [],
    );
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(current < 0 ? -1 : current, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(current < 0 ? 0 : current, -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      options[event.key === "Home" ? 0 : options.length - 1]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const pick = (next: MicrophoneNoiseMode) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (next !== mode) onChange(next);
  };

  return (
    <div className="field">
      <span id={labelId}>麦克风降噪</span>
      <button
        type="button"
        ref={triggerRef}
        className="field-select"
        // 名字里同时带上字段名和当前值，和原生 select 的朗读结果保持一致。
        aria-labelledby={`${labelId} ${valueId}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={blocked}
        onClick={() => setOpen((value) => !value)}
      >
        <span id={valueId}>{selectedLabel}</span>
        <CaretDown size={14} weight="bold" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="popover-card noise-mode-menu"
            role="listbox"
            aria-labelledby={labelId}
            style={{
              ...menuStyle,
              visibility: positioned ? "visible" : "hidden",
            }}
            onKeyDown={onMenuKeyDown}
          >
            {NOISE_MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === mode}
                onClick={() => pick(option.value)}
              >
                <span>{option.label}</span>
                <Check size={14} weight="bold" />
              </button>
            ))}
          </div>,
          document.body,
        )}
      {busy && (
        <p className="audio-device-action-hint" role="status">
          正在切换降噪，请稍候…
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
