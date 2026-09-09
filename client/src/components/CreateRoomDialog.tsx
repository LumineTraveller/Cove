import { Hash, LockKeyhole, LoaderCircle, Users, X } from 'lucide-react';

interface Props {
  name: string;
  maxMembers: string;
  password: string;
  submitting: boolean;
  submitDisabled?: boolean;
  onName: (value: string) => void;
  onMaxMembers: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function CreateRoomDialog({
  name,
  maxMembers,
  password,
  submitting,
  submitDisabled = false,
  onName,
  onMaxMembers,
  onPassword,
  onSubmit,
  onClose,
}: Props) {
  const limitInvalid = Boolean(
    maxMembers.trim() &&
      (!/^\d+$/.test(maxMembers.trim()) ||
        Number(maxMembers) < 1 ||
        Number(maxMembers) > 1000),
  );
  const disabled = submitting || submitDisabled || !name.trim() || limitInvalid;

  return (
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="settings-modal room-settings create-room-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) onSubmit();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-room-title"
      >
        <header>
          <div>
            <small>创建后你会成为房主</small>
            <h2 id="create-room-title">新建频道</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="关闭新建频道"
          >
            <X size={20} />
          </button>
        </header>
        <div className="settings-scroll">
          <label className="field" htmlFor="create-room-name">
            <span>频道名称</span>
            <div className="create-room-input-wrap">
              <Hash size={17} aria-hidden="true" />
              <input
                id="create-room-name"
                autoFocus
                value={name}
                maxLength={80}
                placeholder="例如：周末放映室"
                onChange={(event) => onName(event.target.value)}
              />
            </div>
          </label>
          <div className="two-fields">
            <label className="field" htmlFor="create-room-limit">
              <span>人数上限（可选）</span>
              <div className="create-room-input-wrap">
                <Users size={17} aria-hidden="true" />
                <input
                  id="create-room-limit"
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  inputMode="numeric"
                  value={maxMembers}
                  placeholder="留空表示不限"
                  aria-invalid={limitInvalid}
                  onChange={(event) => onMaxMembers(event.target.value)}
                />
              </div>
            </label>
            <label className="field" htmlFor="create-room-password">
              <span>密码（可选）</span>
              <div className="create-room-input-wrap">
                <LockKeyhole size={17} aria-hidden="true" />
                <input
                  id="create-room-password"
                  type="password"
                  value={password}
                  maxLength={128}
                  onChange={(event) => onPassword(event.target.value)}
                />
              </div>
            </label>
          </div>
          {limitInvalid && (
            <p className="field-error">人数上限必须是 1 到 1000 的整数，或留空不限人数。</p>
          )}
          <div className="settings-actions">
            <button type="button" className="plain-action" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="primary-wide" disabled={disabled}>
              {submitting && <LoaderCircle size={17} className="spin" />}
              {submitting ? "创建中…" : "创建频道"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
