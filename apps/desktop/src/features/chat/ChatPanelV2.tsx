import {
  ArrowDown,
  ChatCircleDots,
  Check,
  Clipboard,
  Copy,
  DownloadSimple,
  ImageSquare,
  Info,
  PaperPlaneTilt,
  Radio,
  TextAa,
  X,
} from '@phosphor-icons/react';
import {
  Fragment,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { Message, UserProfile } from '../../types';
import { authorizedResourceURL } from '../connection/serverSecurity';
import { Avatar } from '../profiles/components/Avatar';
import {
  getProfileDisplayContent,
  getProfileDisplayName,
  type ProfileRemarks,
} from '../profiles/profileRemarks';
import { ChatFontMenu, ChatFontSize } from '../settings/ChatFontMenu';
import { CHAT_IMAGE_MAX_BATCH, collectChatImageFiles, validateChatImageFile } from './chatImages';
import { parseChatText } from './chatLinks';

export function ChatPanelV2({
  messages,
  profile,
  serverURL,
  roomBottom,
  roomForeground,
  getMemberAvatar,
  currentUserId,
  profileRemarks,
  input,
  setInput,
  onSend,
  onSendImages,
  imageError,
  onDismissImageError,
  onImageError,
  compact,
  fontSize,
  onFontSizeChange,
  hasOlderMessages,
  loadingOlderMessages,
  historyLoadVersion,
  onLoadOlderMessages,
}: {
  messages: Message[];
  profile: UserProfile;
  serverURL: string;
  roomBottom: string;
  roomForeground: string;
  getMemberAvatar: (userId?: string | null, username?: string) => string | null | undefined;
  currentUserId?: string;
  profileRemarks: ProfileRemarks;
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  onSendImages: (files: FileList | File[] | null) => void;
  imageError: string | null;
  onDismissImageError: () => void;
  onImageError: (message: string | null) => void;
  compact: boolean;
  unread: number;
  fontSize: ChatFontSize;
  onFontSizeChange: (value: ChatFontSize) => void;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  historyLoadVersion: number;
  onLoadOlderMessages: () => void;
}) {
  const imageRef = useRef<HTMLInputElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const imageMenuRef = useRef<HTMLDivElement>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const copyNoticeTimerRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const previousMessageCountRef = useRef(messages.length);
  const firstMessageRenderRef = useRef(true);
  const stickToBottomRef = useRef(true);
  const historyScrollAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const handledHistoryLoadVersionRef = useRef(historyLoadVersion);
  const olderRequestPendingRef = useRef(false);
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  // 大图查看：滚轮缩放 + 拖拽平移。缩放 1 倍时不允许拖动，保持点击关闭的手感。
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const [lightboxOffset, setLightboxOffset] = useState({ x: 0, y: 0 });
  const lightboxRef = useRef<HTMLDivElement>(null);
  const lightboxImageRef = useRef<HTMLImageElement>(null);
  const lightboxDragRef = useRef<{
    pointerX: number;
    pointerY: number;
    originX: number;
    originY: number;
  } | null>(null);
  useEffect(() => {
    setLightboxZoom(1);
    setLightboxOffset({ x: 0, y: 0 });
    lightboxDragRef.current = null;
  }, [lightboxImage]);
  useEffect(() => {
    const element = lightboxRef.current;
    if (!element || !lightboxImage) return;
    // React 的 onWheel 是被动监听，无法阻止页面滚动；这里显式注册非被动监听。
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setLightboxZoom((current) => {
        const next = Math.max(1, Math.min(6, current * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
        if (next === 1) setLightboxOffset({ x: 0, y: 0 });
        return next;
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [lightboxImage]);
  const lightboxPanLimit = () => {
    const node = lightboxImageRef.current;
    const scale = Math.max(0, lightboxZoom - 1);
    if (!node) return { x: 0, y: 0 };
    return {
      x: (node.offsetWidth * scale) / 2,
      y: (node.offsetHeight * scale) / 2,
    };
  };
  const startLightboxDrag = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (lightboxZoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    lightboxDragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: lightboxOffset.x,
      originY: lightboxOffset.y,
    };
  };
  const moveLightboxDrag = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = lightboxDragRef.current;
    if (!drag) return;
    const limit = lightboxPanLimit();
    setLightboxOffset({
      x: Math.max(-limit.x, Math.min(limit.x, drag.originX + (event.clientX - drag.pointerX))),
      y: Math.max(-limit.y, Math.min(limit.y, drag.originY + (event.clientY - drag.pointerY))),
    });
  };
  const endLightboxDrag = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!lightboxDragRef.current) return;
    lightboxDragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const [fontMenuOpen, setFontMenuOpen] = useState(false);
  const fontHoverTimerRef = useRef<number | null>(null);
  const openFontMenuOnHover = () => {
    if (fontHoverTimerRef.current !== null) window.clearTimeout(fontHoverTimerRef.current);
    setFontMenuOpen(true);
  };
  const closeFontMenuOnHover = () => {
    if (fontHoverTimerRef.current !== null) window.clearTimeout(fontHoverTimerRef.current);
    fontHoverTimerRef.current = window.setTimeout(() => {
      setFontMenuOpen(false);
      fontHoverTimerRef.current = null;
    }, 260);
  };
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [imageContextMenu, setImageContextMenu] = useState<{
    src: string;
    x: number;
    y: number;
  } | null>(null);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const list = messageListRef.current;
    if (!list) return;
    stickToBottomRef.current = true;
    if (programmaticScrollTimerRef.current !== null)
      window.clearTimeout(programmaticScrollTimerRef.current);
    programmaticScrollRef.current = behavior === 'smooth';
    const initialHeight = list.scrollHeight;
    if (behavior === 'smooth') list.scrollTo({ top: initialHeight, behavior: 'smooth' });
    else list.scrollTop = initialHeight;
    requestAnimationFrame(() => {
      const current = messageListRef.current;
      if (!current) return;
      if (current.scrollHeight !== initialHeight) {
        if (behavior === 'smooth')
          current.scrollTo({ top: current.scrollHeight, behavior: 'smooth' });
        else current.scrollTop = current.scrollHeight;
      }
      requestAnimationFrame(() => {
        if (behavior === 'auto') {
          current.scrollTop = current.scrollHeight;
          programmaticScrollRef.current = false;
        }
      });
    });
    if (behavior === 'smooth') {
      programmaticScrollTimerRef.current = window.setTimeout(() => {
        programmaticScrollRef.current = false;
        programmaticScrollTimerRef.current = null;
      }, 900);
    }
  }, []);
  useLayoutEffect(() => {
    if (
      historyLoadVersion === handledHistoryLoadVersionRef.current ||
      !historyScrollAnchorRef.current
    )
      return;
    const list = messageListRef.current;
    const anchor = historyScrollAnchorRef.current;
    if (list) {
      list.scrollTop = anchor.scrollTop + (list.scrollHeight - anchor.scrollHeight);
    }
    historyScrollAnchorRef.current = null;
  }, [historyLoadVersion, messages.length]);
  useEffect(() => {
    const previousCount = previousMessageCountRef.current;
    // 语音包播放与人员进出播报不算新消息，不计入提醒。
    const addedCount = messages
      .slice(previousCount)
      .filter((message) => message.type !== 'system' && message.type !== 'soundpack').length;
    previousMessageCountRef.current = messages.length;
    const isHistoryLoad = historyLoadVersion !== handledHistoryLoadVersionRef.current;
    handledHistoryLoadVersionRef.current = historyLoadVersion;
    if (isHistoryLoad) {
      setNewMessageCount(0);
      return;
    }
    if (firstMessageRenderRef.current) {
      firstMessageRenderRef.current = false;
      setNewMessageCount(0);
      scrollToBottom('auto');
      return;
    }
    if (addedCount <= 0) return;
    const list = messageListRef.current;
    if (stickToBottomRef.current || isMessageListNearBottom(list)) {
      setNewMessageCount(0);
      scrollToBottom('smooth');
    } else {
      setNewMessageCount((current) => current + addedCount);
    }
  }, [historyLoadVersion, messages.length, scrollToBottom]);
  useEffect(() => {
    if (!loadingOlderMessages) olderRequestPendingRef.current = false;
  }, [loadingOlderMessages]);
  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const syncBottom = () => {
      if (stickToBottomRef.current) list.scrollTop = list.scrollHeight;
    };
    syncBottom();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncBottom);
    Array.from(list.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [messages.length]);
  useEffect(() => {
    return () => {
      if (fontHoverTimerRef.current !== null) window.clearTimeout(fontHoverTimerRef.current);
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
      if (copyNoticeTimerRef.current !== null) window.clearTimeout(copyNoticeTimerRef.current);
      if (programmaticScrollTimerRef.current !== null)
        window.clearTimeout(programmaticScrollTimerRef.current);
    };
  }, []);
  useEffect(() => {
    if (!fontMenuOpen && !imageContextMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (fontMenuOpen && (!(target instanceof Element) || !target.closest('.chat-font-picker'))) {
        setFontMenuOpen(false);
      }
      if (
        imageContextMenu &&
        (!(target instanceof Node) || !imageMenuRef.current?.contains(target))
      ) {
        setImageContextMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setFontMenuOpen(false);
      setImageContextMenu(null);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [fontMenuOpen, imageContextMenu]);
  const imageUrl = (value: string) => {
    if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value;
    const target = `${serverURL.replace(/\/$/, '')}${value.startsWith('/') ? value : `/${value}`}`;
    return authorizedResourceURL(serverURL, target);
  };
  const showCopyNotice = (notice: string) => {
    setCopyNotice(notice);
    if (copyNoticeTimerRef.current !== null) window.clearTimeout(copyNoticeTimerRef.current);
    copyNoticeTimerRef.current = window.setTimeout(() => setCopyNotice(null), 1600);
  };
  const copyMessage = async (messageId: string, content: string) => {
    try {
      await copyTextToClipboard(content);
      setCopiedMessageId(messageId);
      showCopyNotice('已复制消息');
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(
        () => setCopiedMessageId((current) => (current === messageId ? null : current)),
        1600,
      );
    } catch (error) {
      console.warn('[chat-copy] 文本复制失败', error);
      showCopyNotice('复制失败，请重试');
    }
  };
  const copyImage = async (src: string) => {
    try {
      await copyImageToClipboard(src);
      showCopyNotice('图片已复制');
    } catch (error) {
      console.warn('[chat-copy] 图片复制失败', error);
      showCopyNotice('复制图片失败，请重试');
    }
  };
  const downloadImage = async (src: string) => {
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const mimeSubtype = blob.type.split('/')[1]?.split(';')[0] ?? 'png';
      const extension = mimeSubtype === 'jpeg' ? 'jpg' : mimeSubtype;
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `cove-image-${Date.now()}.${extension}`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      showCopyNotice('图片已开始下载');
    } catch (error) {
      console.warn('[chat-download] 图片下载失败', error);
      showCopyNotice('下载图片失败，请重试');
    }
  };
  const openImageContextMenu = (event: MouseEvent<HTMLElement>, src: string) => {
    event.preventDefault();
    const menuWidth = 160;
    const menuHeight = 84;
    setImageContextMenu({
      src,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
  };
  const stageImages = (files: FileList | File[]) => {
    setDragActive(false);
    const images = collectChatImageFiles(files);
    if (!images.length) return;
    if (images.length > CHAT_IMAGE_MAX_BATCH) {
      onImageError(`一次最多发送 ${CHAT_IMAGE_MAX_BATCH} 张图片。`);
      return;
    }
    for (const file of images) {
      const validationError = validateChatImageFile(file);
      if (validationError) {
        onImageError(validationError);
        return;
      }
    }
    onImageError(null);
    setPendingImages(images);
  };
  const confirmImages = () => {
    if (!pendingImages.length) return;
    const images = pendingImages;
    setPendingImages([]);
    onSendImages(images);
  };
  return (
    <aside
      className={`chat-panel chat-font-${fontSize} ${compact ? 'compact' : ''} ${
        dragActive ? 'drag-active' : ''
      }`}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) setDragActive(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        stageImages(event.dataTransfer.files);
      }}
    >
      {!compact && (
        <header>
          <div className="chat-header-actions chat-header-actions-left">
            <div
              className="chat-font-picker"
              onMouseEnter={openFontMenuOnHover}
              onMouseLeave={closeFontMenuOnHover}
              onFocus={openFontMenuOnHover}
            >
              <button
                type="button"
                className={`icon-btn chat-font-button ${fontMenuOpen ? 'active' : ''}`}
                onClick={openFontMenuOnHover}
                aria-label="调整聊天字号"
                aria-expanded={fontMenuOpen}
                title="调整聊天字号"
              >
                <TextAa size={18} />
              </button>
              {fontMenuOpen && (
                <ChatFontMenu
                  fontSize={fontSize}
                  onFontSizeChange={onFontSizeChange}
                  onClose={() => setFontMenuOpen(false)}
                  onMouseEnter={openFontMenuOnHover}
                  onMouseLeave={closeFontMenuOnHover}
                />
              )}
            </div>
          </div>
        </header>
      )}
      {copyNotice && (
        <div className="chat-copy-notice" role="status">
          {copyNotice}
        </div>
      )}
      <div
        ref={messageListRef}
        className="message-list"
        onScroll={(event) => {
          const list = event.currentTarget;
          const nearBottom = isMessageListNearBottom(list);
          if (programmaticScrollRef.current && !nearBottom) return;
          if (nearBottom) {
            stickToBottomRef.current = true;
            setNewMessageCount(0);
            return;
          }
          stickToBottomRef.current = false;
          if (
            list.scrollTop <= 36 &&
            hasOlderMessages &&
            !loadingOlderMessages &&
            !olderRequestPendingRef.current
          ) {
            olderRequestPendingRef.current = true;
            historyScrollAnchorRef.current = {
              scrollHeight: list.scrollHeight,
              scrollTop: list.scrollTop,
            };
            onLoadOlderMessages();
          }
        }}
      >
        {messages.length === 0 && (
          <div className="chat-empty">
            <span className="chat-empty-icon">
              <ChatCircleDots size={32} weight="fill" />
            </span>
            <p>这里还是空的，发条消息吧。</p>
          </div>
        )}
        {messages.map((message, index) => {
          const authorName = getProfileDisplayName(
            message.author,
            message.authorUserId,
            profileRemarks,
          );
          const messageContent = getProfileDisplayContent(
            message.content,
            message.contentUsername,
            message.contentUserId,
            profileRemarks,
          );
          const isOwn =
            message.authorUserId && currentUserId
              ? message.authorUserId === currentUserId
              : message.author === profile.username;
          const showDate =
            index === 0 || !sameMessageDay(messages[index - 1].timestamp, message.timestamp);
          return (
            <Fragment key={message.id}>
              {showDate && (
                <div className="message-date-divider" role="separator">
                  <span>{formatMessageDate(message.timestamp)}</span>
                </div>
              )}
              {message.type === 'system' || message.type === 'soundpack' ? (
                <div className="message-system">
                  <Radio size={14} />
                  {messageContent}
                </div>
              ) : (
                <article
                  className={`message-row ${isOwn ? 'mine' : ''} ${
                    message.type === 'image' ? 'image-message' : ''
                  }`}
                >
                  <Avatar
                    username={authorName}
                    avatarUrl={
                      isOwn
                        ? profile.avatarUrl
                        : getMemberAvatar(message.authorUserId, message.author)
                    }
                    size="sm"
                    className="message-avatar"
                  />
                  <div className="message-copy">
                    <div className="message-meta">
                      <b>{isOwn ? '你' : authorName}</b>
                      <time>
                        {new Date(message.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                    <div className={`message-bubble ${message.type === 'image' ? 'image' : ''}`}>
                      {message.type === 'image' ? (
                        <ChatImagePreview
                          src={imageUrl(message.content)}
                          onOpen={() => setLightboxImage(imageUrl(message.content))}
                          onContextMenu={(event) =>
                            openImageContextMenu(event, imageUrl(message.content))
                          }
                        />
                      ) : (
                        <>
                          <span className="message-text-content">
                            {parseChatText(messageContent).map((part, partIndex) =>
                              part.kind === 'link' && part.href ? (
                                <a
                                  key={partIndex}
                                  href={part.href}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    window.coveShell
                                      ? void window.coveShell.openExternal(part.href!)
                                      : window.open(part.href, '_blank', 'noopener,noreferrer');
                                  }}
                                >
                                  {part.text}
                                </a>
                              ) : (
                                <span key={partIndex}>{part.text}</span>
                              ),
                            )}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  {message.type !== 'image' && (
                    <button
                      type="button"
                      className="message-copy-button"
                      onClick={() => void copyMessage(message.id, message.content)}
                      aria-label={copiedMessageId === message.id ? '已复制消息' : '复制消息'}
                      title={copiedMessageId === message.id ? '已复制' : '复制消息'}
                    >
                      {copiedMessageId === message.id ? (
                        <Check size={14} weight="bold" />
                      ) : (
                        <Copy size={14} />
                      )}
                    </button>
                  )}
                </article>
              )}
            </Fragment>
          );
        })}
      </div>
      {newMessageCount > 0 && (
        <button
          type="button"
          className="chat-new-message-notice"
          onClick={() => {
            setNewMessageCount(0);
            scrollToBottom('smooth');
          }}
        >
          <ArrowDown size={14} weight="bold" />
          <span>{newMessageCount} 条新消息 · 回到底部</span>
        </button>
      )}
      <div className="chat-composer-wrap">
        {imageError && (
          <div className="chat-image-error popover-card" role="alert">
            <div className="chat-image-error-copy">
              <span className="chat-image-error-icon">
                <Info size={17} weight="bold" />
              </span>
              <div>
                <strong>图片无法发送</strong>
                <p>{imageError}</p>
              </div>
            </div>
            <button
              type="button"
              className="chat-image-error-close"
              onClick={onDismissImageError}
              aria-label="关闭提示"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {pendingImages.length > 0 && (
          <div className="image-send-confirm popover-card" role="dialog">
            <div className="image-send-confirm-copy">
              <ImageSquare size={17} />
              <span>已选择 {pendingImages.length} 张图片，确认发送？</span>
            </div>
            <div className="image-send-confirm-actions">
              <button type="button" onClick={() => setPendingImages([])}>
                取消
              </button>
              <button type="button" className="primary" onClick={confirmImages}>
                发送
              </button>
            </div>
          </div>
        )}
        <div className="chat-composer">
          <input
            ref={imageRef}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(event) => {
              onSendImages(event.target.files);
              event.currentTarget.value = '';
            }}
          />
          <button
            className="icon-btn"
            onClick={() => imageRef.current?.click()}
            aria-label="添加图片"
            title="添加图片（最大 10MB）"
          >
            <ImageSquare size={19} />
          </button>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onPaste={(event) => {
              const pastedImages = Array.from(event.clipboardData.items)
                .filter((item) => item.kind === 'file')
                .map((item) => item.getAsFile())
                .filter((file): file is File => Boolean(file));
              if (!pastedImages.length) return;
              event.preventDefault();
              if (pastedImages.length !== 1 || pastedImages[0].type === 'image/gif') {
                stageImages(pastedImages);
                return;
              }
              const html = event.clipboardData.getData('text/html');
              const gifSrc = html
                ? new DOMParser()
                    .parseFromString(html, 'text/html')
                    .querySelector<HTMLImageElement>('img[src^="data:image/gif;base64,"]')?.src
                : undefined;
              const stageHtmlGifOrImages = () => {
                if (gifSrc && gifSrc.length <= 14 * 1024 * 1024) {
                  void fetch(gifSrc)
                    .then((response) => response.blob())
                    .then((blob) =>
                      stageImages([new File([blob], 'animation.gif', { type: 'image/gif' })]),
                    )
                    .catch(() => stageImages(pastedImages));
                } else {
                  stageImages(pastedImages);
                }
              };
              if (!window.coveClipboard?.readGif) {
                stageHtmlGifOrImages();
                return;
              }
              void window.coveClipboard
                .readGif()
                .then((bytes) => {
                  if (bytes?.length) {
                    const gifBytes = new Uint8Array(bytes.length);
                    gifBytes.set(bytes);
                    stageImages([new File([gifBytes], 'animation.gif', { type: 'image/gif' })]);
                  } else {
                    stageHtmlGifOrImages();
                  }
                })
                .catch(stageHtmlGifOrImages);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            placeholder="发送消息"
            rows={1}
          />
          <button
            className="icon-btn"
            onClick={onSend}
            disabled={!input.trim()}
            aria-label="发送消息"
          >
            <PaperPlaneTilt size={20} weight="fill" />
          </button>
        </div>
      </div>
      {/* 坐标来自 clientX/clientY，必须挂在 body 上：共享态的 .chat-slot 带
          transform，会把 fixed 后代的包含块改成聊天区，菜单会整体偏移并被裁掉。 */}
      {imageContextMenu &&
        createPortal(
          <div
            ref={imageMenuRef}
            className="chat-image-context-menu"
            style={
              {
                left: imageContextMenu.x,
                top: imageContextMenu.y,
                // Portals mount under body, so carry the room-scoped tokens
                // that the menu normally inherits from .cove-shell.
                '--room-bottom': roomBottom,
                '--room-fg': roomForeground,
              } as React.CSSProperties
            }
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const src = imageContextMenu.src;
                setImageContextMenu(null);
                void downloadImage(src);
              }}
            >
              <DownloadSimple size={16} />
              <span>下载图片</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const src = imageContextMenu.src;
                setImageContextMenu(null);
                void copyImage(src);
              }}
            >
              <Clipboard size={16} />
              <span>复制图片</span>
            </button>
          </div>,
          document.body,
        )}
      {/* 大图查看必须挂到 body：共享态的 .chat-slot 带 transform 与
          will-change:transform，会为 position:fixed 后代建立包含块，否则查看器
          只能铺满聊天区而不是整个窗口。 */}
      {lightboxImage &&
        createPortal(
          <div
            ref={lightboxRef}
            className="image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="查看聊天图片"
            onClick={() => setLightboxImage(null)}
          >
            <img
              ref={lightboxImageRef}
              src={lightboxImage}
              alt="放大的聊天图片"
              className={lightboxZoom > 1 ? 'is-zoomed' : ''}
              title="滚轮缩放，按住拖动查看其他区域，点击空白处关闭"
              style={{
                transform: `translate(${lightboxOffset.x}px, ${lightboxOffset.y}px) scale(${lightboxZoom})`,
              }}
              onContextMenu={(event) => openImageContextMenu(event, lightboxImage)}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={startLightboxDrag}
              onPointerMove={moveLightboxDrag}
              onPointerUp={endLightboxDrag}
              onPointerCancel={endLightboxDrag}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setLightboxZoom(1);
                setLightboxOffset({ x: 0, y: 0 });
              }}
            />
          </div>,
          document.body,
        )}
    </aside>
  );
}

export function ChatImagePreview({
  src,
  onOpen,
  onContextMenu,
}: {
  src: string;
  onOpen: () => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const [width, setWidth] = useState(320);
  return (
    <button
      type="button"
      className="image-preview-button"
      style={{ width }}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      aria-label="放大查看聊天图片"
    >
      <img
        src={src}
        alt="聊天图片"
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth && naturalHeight)
            setWidth(Math.min(320, naturalWidth, (280 * naturalWidth) / naturalHeight));
        }}
      />
    </button>
  );
}

export async function copyTextToClipboard(value: string) {
  if (window.coveClipboard?.writeText) {
    try {
      if (await window.coveClipboard.writeText(value)) return;
    } catch {
      // 原生通道不可用时继续尝试渲染进程的剪贴板接口。
    }
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // 某些 Electron 页面会暴露接口，但实际写入时拒绝请求。
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  const copied = document.execCommand('copy');
  textarea.remove();
  if (copied) return;
  if (window.coveClipboard?.writeText) {
    try {
      if (await window.coveClipboard.writeText(value)) return;
    } catch {
      // 统一在函数末尾报告复制失败。
    }
  }
  throw new Error('复制文本失败');
}

export async function copyImageToClipboard(src: string) {
  const response = await fetch(src);
  if (!response.ok) throw new Error('读取图片失败');
  const sourceBlob = await response.blob();
  const isGif = sourceBlob.type === 'image/gif';
  let clipboardBlob = sourceBlob;

  // 保留 GIF 原始帧，同时提供首帧 PNG 供不支持 GIF 的目标使用。
  // 其它格式继续转成兼容性较好的 PNG。
  if (sourceBlob.type !== 'image/png') {
    const objectUrl = URL.createObjectURL(sourceBlob);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new window.Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('解码图片失败'));
        element.src = objectUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context || !canvas.width || !canvas.height) throw new Error('转换图片失败');
      context.drawImage(image, 0, 0);
      clipboardBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('转换图片失败'))),
          'image/png',
        );
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
  if (window.coveClipboard?.writeImage) {
    try {
      if (
        await window.coveClipboard.writeImage(
          new Uint8Array(await (isGif ? sourceBlob : clipboardBlob).arrayBuffer()),
          isGif ? 'image/gif' : 'image/png',
          isGif ? new Uint8Array(await clipboardBlob.arrayBuffer()) : undefined,
        )
      )
        return;
    } catch {
      // 原生通道不可用时继续尝试浏览器剪贴板接口。
    }
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    throw new Error('当前环境不支持复制图片');
  if (isGif) {
    const html = new Blob([`<img src="${await readFileAsDataUrl(sourceBlob)}">`], {
      type: 'text/html',
    });
    const fallback = { 'image/png': clipboardBlob, 'text/html': html };
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ ...fallback, 'web image/gif': sourceBlob }),
      ]);
    } catch {
      await navigator.clipboard.write([new ClipboardItem(fallback)]);
    }
    return;
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': clipboardBlob })]);
}

export function readFileAsDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export function openExternalLink(event: MouseEvent<HTMLAnchorElement>, url: string) {
  event.preventDefault();
  if (window.coveShell) {
    void window.coveShell.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function sameMessageDay(firstTimestamp: number, secondTimestamp: number) {
  const first = new Date(firstTimestamp);
  const second = new Date(secondTimestamp);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

export function formatMessageDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(timestamp));
}

export function isMessageListNearBottom(element: HTMLElement | null) {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
}

export function mergeChatMessages(current: Message[], incoming: Message[]) {
  const merged = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => merged.set(message.id, message));
  return [...merged.values()].sort((left, right) => left.timestamp - right.timestamp);
}
