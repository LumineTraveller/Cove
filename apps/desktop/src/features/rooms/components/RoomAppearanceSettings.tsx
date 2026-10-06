import { useRef, useState } from 'react';
import { DoorOpen, Trash, UploadSimple, X } from '@phosphor-icons/react';
import { AvatarCropDialog } from '../../profiles/components/AvatarCropDialog';
import type { AppTheme } from '../../settings/theme';
import {
  RoomWithAppearance,
  roomColor,
  ROOM_LIGHT_TOP,
  ROOM_LIGHT_BOTTOM,
  ROOM_DARK_TOP,
  ROOM_DARK_BOTTOM,
  resolveRoomAvatarUrl,
} from '../appearance';

export function RoomAppearanceSettings({
  room,
  onSave,
  onClose,
  onDelete,
  theme = 'light',
}: {
  room: RoomWithAppearance;
  onSave: (changes: Record<string, unknown>) => void;
  onClose: () => void;
  onDelete: () => void;
  theme?: AppTheme;
}) {
  const [name, setName] = useState(room.name);
  const [backgroundMode, setBackgroundMode] = useState<AppTheme>(theme);
  const [lightTop, setLightTop] = useState(roomColor(room.backgroundTop, ROOM_LIGHT_TOP));
  const [lightBottom, setLightBottom] = useState(
    roomColor(room.backgroundBottom, ROOM_LIGHT_BOTTOM),
  );
  const [darkTop, setDarkTop] = useState(roomColor(room.backgroundTopDark, ROOM_DARK_TOP));
  const [darkBottom, setDarkBottom] = useState(
    roomColor(room.backgroundBottomDark, ROOM_DARK_BOTTOM),
  );
  // 只有用户真正动过的那一套主题背景才会被提交。未编辑的一套不下发对应字段，
  // 由服务端沿用数据库中的原值，避免浅色/深色互相覆盖。
  const [lightColorsDirty, setLightColorsDirty] = useState(false);
  const [darkColorsDirty, setDarkColorsDirty] = useState(false);
  const markColorsDirty = (mode: AppTheme) => {
    if (mode === 'dark') setDarkColorsDirty(true);
    else setLightColorsDirty(true);
  };
  const top = backgroundMode === 'dark' ? darkTop : lightTop;
  const bottom = backgroundMode === 'dark' ? darkBottom : lightBottom;
  const setTop = backgroundMode === 'dark' ? setDarkTop : setLightTop;
  const setBottom = backgroundMode === 'dark' ? setDarkBottom : setLightBottom;
  const [avatar, setAvatar] = useState(resolveRoomAvatarUrl(room.avatarUrl));
  const [maxMembers, setMaxMembers] = useState(
    room.maxMembers ? String(room.maxMembers) : 'unlimited',
  );
  const [passwordAction, setPasswordAction] = useState<'keep' | 'set' | 'clear'>('keep');
  const [password, setPassword] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-modal room-settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <small>仅房主可调整</small>
            <h2>房间设置</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭房间设置">
            <X size={20} />
          </button>
        </header>
        <div className="settings-scroll">
          <section className="settings-section">
            <h3>房间资料</h3>
            <div className="room-avatar-editor">
              <span className="room-avatar large">
                {avatar ? (
                  <img src={avatar} alt="房间头像" />
                ) : (
                  <DoorOpen size={22} weight="duotone" />
                )}
                <span className="voice-count">{room.count ?? 0}</span>
              </span>
              <div>
                <b>房间头像</b>
                <p>没有设置时使用默认房间图标。</p>
                <button onClick={() => fileRef.current?.click()}>
                  <UploadSimple size={17} />
                  选择图片
                </button>
                <input
                  ref={fileRef}
                  hidden
                  type="file"
                  accept="image/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) setCropFile(file);
                    event.currentTarget.value = '';
                  }}
                />
              </div>
            </div>
            <label className="field">
              <span>频道名称</span>
              <input
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="two-fields">
              <label className="field">
                <span>人数上限</span>
                <select value={maxMembers} onChange={(event) => setMaxMembers(event.target.value)}>
                  <option value="unlimited">不限人数</option>
                  <option value="5">5 人</option>
                  <option value="10">10 人</option>
                  <option value="20">20 人</option>
                  <option value="50">50 人</option>
                </select>
              </label>
              <label className="field">
                <span>密码操作</span>
                <select
                  value={passwordAction}
                  onChange={(event) =>
                    setPasswordAction(event.target.value as typeof passwordAction)
                  }
                >
                  <option value="keep">保持不变</option>
                  <option value="set">设置新密码</option>
                  <option value="clear">取消密码</option>
                </select>
              </label>
            </div>
            {passwordAction === 'set' && (
              <label className="field">
                <span>新密码</span>
                <input
                  type="password"
                  value={password}
                  maxLength={128}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="输入新密码"
                />
              </label>
            )}
          </section>
          <section className="settings-section">
            <h3>房间背景</h3>
            <p className="section-note">两套主题背景分别保存，切换主题时不会覆盖另一套颜色。</p>
            <div className="theme-segmented-control" role="tablist" aria-label="编辑哪套主题背景">
              <button
                type="button"
                role="tab"
                aria-selected={backgroundMode === 'light'}
                className={backgroundMode === 'light' ? 'active' : ''}
                onClick={() => setBackgroundMode('light')}
              >
                浅色模式
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={backgroundMode === 'dark'}
                className={backgroundMode === 'dark' ? 'active' : ''}
                onClick={() => setBackgroundMode('dark')}
              >
                深色模式
              </button>
            </div>
            <div className="gradient-editor">
              <div
                className="gradient-capsule"
                style={{
                  background: `linear-gradient(90deg, ${top}, ${bottom})`,
                }}
              >
                <label className="color-stop left">
                  <input
                    type="color"
                    value={top}
                    onChange={(event) => {
                      setTop(event.target.value.toUpperCase());
                      markColorsDirty(backgroundMode);
                    }}
                    aria-label="房间顶部颜色"
                  />
                </label>
                <label className="color-stop right">
                  <input
                    type="color"
                    value={bottom}
                    onChange={(event) => {
                      setBottom(event.target.value.toUpperCase());
                      markColorsDirty(backgroundMode);
                    }}
                    aria-label="房间底部颜色"
                  />
                </label>
              </div>
              <div className="color-code-row">
                <label>
                  <span>顶部颜色</span>
                  <input
                    value={top}
                    onChange={(event) => {
                      setTop(event.target.value.toUpperCase());
                      markColorsDirty(backgroundMode);
                    }}
                  />
                </label>
                <label>
                  <span>底部颜色</span>
                  <input
                    value={bottom}
                    onChange={(event) => {
                      setBottom(event.target.value.toUpperCase());
                      markColorsDirty(backgroundMode);
                    }}
                  />
                </label>
              </div>
            </div>
          </section>
          <section className="danger-zone">
            <div>
              <b>删除频道</b>
              <p>此操作无法撤销。</p>
            </div>
            <button type="button" onClick={() => setConfirmingDelete(true)}>
              <Trash size={17} />
              删除频道
            </button>
          </section>
          {confirmingDelete && (
            <div
              className="room-delete-confirm-scrim modal-scrim"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setConfirmingDelete(false);
              }}
            >
              <section
                className="room-delete-confirm popover-card"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="room-delete-confirm-title"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <span className="room-delete-confirm-icon">
                  <Trash size={21} />
                </span>
                <h3 id="room-delete-confirm-title">删除频道</h3>
                <p>确定删除“{room.name}”吗？此操作无法撤销。</p>
                <div className="room-delete-confirm-actions">
                  <button
                    type="button"
                    className="plain-action"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="danger-confirm"
                    onClick={() => {
                      setConfirmingDelete(false);
                      onDelete();
                    }}
                  >
                    <Trash size={16} />
                    删除频道
                  </button>
                </div>
              </section>
            </div>
          )}
          <button
            className="primary-wide"
            onClick={() => {
              // 只提交用户实际编辑过的那一套主题背景；未编辑的一套不下发该字段，
              // 由服务端沿用数据库原值，避免两套主题互相覆盖。
              const colorChanges: Record<string, string> = {};
              if (lightColorsDirty) {
                colorChanges.backgroundTop = lightTop;
                colorChanges.backgroundBottom = lightBottom;
              }
              if (darkColorsDirty) {
                colorChanges.backgroundTopDark = darkTop;
                colorChanges.backgroundBottomDark = darkBottom;
              }
              onSave({
                name: name.trim() || room.name,
                avatarUrl: avatar,
                ...colorChanges,
                maxMembers: maxMembers === 'unlimited' ? null : Number(maxMembers),
                password:
                  passwordAction === 'set'
                    ? password
                    : passwordAction === 'clear'
                    ? null
                    : undefined,
              });
            }}
          >
            保存房间设置
          </button>
        </div>
      </section>
      {cropFile && (
        <AvatarCropDialog
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onConfirm={(avatarUrl) => {
            setAvatar(avatarUrl);
            setCropFile(null);
          }}
        />
      )}
    </div>
  );
}
