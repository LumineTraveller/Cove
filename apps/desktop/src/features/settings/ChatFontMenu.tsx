export type ChatFontSize = 'small' | 'medium' | 'large';

export const CHAT_FONT_SIZE_STORAGE_KEY = 'cove-chat-font-size';

export const CHAT_FONT_SIZE_OPTIONS: ReadonlyArray<{
  value: ChatFontSize;
  label: string;
  pixels: number;
}> = [
  { value: 'small', label: '小', pixels: 14 },
  { value: 'medium', label: '标准', pixels: 16 },
  { value: 'large', label: '大', pixels: 18 },
];

export function readChatFontSize(): ChatFontSize {
  try {
    const value = window.localStorage.getItem(CHAT_FONT_SIZE_STORAGE_KEY);
    if (value === 'small' || value === 'medium' || value === 'large') return value;
  } catch {
    // 浏览器禁用本地存储时仍使用默认字号。
  }
  return 'medium';
}

export function ChatFontMenu({
  fontSize,
  onFontSizeChange,
  onClose,
  className = '',
  onMouseEnter,
  onMouseLeave,
}: {
  fontSize: ChatFontSize;
  onFontSizeChange: (value: ChatFontSize) => void;
  onClose?: () => void;
  className?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <div
      className={`chat-font-menu ${className}`.trim()}
      role="menu"
      aria-label="聊天字号"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className="chat-font-menu-title">消息字号</span>
      {CHAT_FONT_SIZE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={fontSize === option.value}
          className={fontSize === option.value ? 'active' : ''}
          onClick={() => {
            onFontSizeChange(option.value);
            onClose?.();
          }}
        >
          <span>{option.label}</span>
          <b style={{ fontSize: option.pixels }}>Aa</b>
        </button>
      ))}
    </div>
  );
}
