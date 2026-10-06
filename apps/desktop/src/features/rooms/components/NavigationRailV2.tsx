import { ArrowRight, CaretLeft, DoorOpen, GearSix, Plus } from '@phosphor-icons/react';
import { useId, useRef } from 'react';
import { RoomWithAppearance, resolveRoomAvatarUrl } from '../appearance';

export function NavigationRailV2({
  rooms,
  activeRoom,
  profileName,
  onRoom,
  expanded,
  setExpanded,
  onSettings,
  onRoomSettings,
  onCreate,
  showCollapse = true,
  className = '',
}: {
  rooms: RoomWithAppearance[];
  activeRoom: string;
  profileName: string;
  onRoom: (id: string) => void;
  expanded: boolean;
  setExpanded: (value: boolean) => void;
  onSettings: () => void;
  onRoomSettings: (room: RoomWithAppearance) => void;
  onCreate: () => void;
  showCollapse?: boolean;
  className?: string;
}) {
  const roomListId = useId();
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <aside className={`navigation-rail ${expanded ? 'expanded' : 'narrow'} ${className}`.trim()}>
      <div className="nav-brand">
        <button
          ref={expandButtonRef}
          className={`logo-swap ${expanded ? 'expanded' : 'narrow'}`}
          onClick={() => setExpanded(true)}
          aria-label="展开频道栏"
          title="展开频道栏"
          aria-expanded={expanded}
          aria-controls={roomListId}
        >
          <img className="app-mark-image" src="./assets/cove-icon.png" alt="Cove" />
          <span className="expand-mark" aria-hidden="true">
            <ArrowRight size={22} />
          </span>
        </button>
        <span className="brand-name" aria-hidden={!expanded}>Cove</span>
        {showCollapse && (
          <button
            className="icon-btn nav-collapse"
            onClick={() => {
              expandButtonRef.current?.focus({ preventScroll: true });
              setExpanded(false);
            }}
            aria-label="收回频道栏"
            aria-controls={roomListId}
            aria-expanded={expanded}
            aria-hidden={!expanded}
            tabIndex={expanded ? 0 : -1}
            disabled={!expanded}
          >
            <CaretLeft size={20} />
          </button>
        )}
      </div>
      <div className="room-nav-list" id={roomListId}>
        {rooms.map((room) => (
          <div
            className={`room-nav-item ${room.id === activeRoom ? 'active' : ''} ${(room.isOwner ?? room.ownerName === profileName) ? 'has-settings' : ''}`.trim()}
            key={room.id}
            data-room-name={room.name}
          >
            <button
              className="room-switch"
              onClick={() => onRoom(room.id)}
              onContextMenu={(event) => {
                if (!(room.isOwner ?? room.ownerName === profileName)) return;
                event.preventDefault();
                onRoomSettings(room);
              }}
              aria-label={`进入频道 ${room.name}`}
            >
              <span className="room-avatar">
                {room.avatarUrl ? (
                  <img src={resolveRoomAvatarUrl(room.avatarUrl) ?? undefined} alt="" />
                ) : (
                  <DoorOpen size={20} weight="duotone" />
                )}
                <span className="voice-count">{room.count ?? 0}</span>
              </span>
              <span className="room-nav-copy-clip" aria-hidden="true">
                <span className="room-nav-copy">
                  <b>{room.name}</b>
                  <small>{room.count ? `${room.count} 人语音中` : '暂无语音'}</small>
                </span>
              </span>
            </button>
            {(room.isOwner ?? room.ownerName === profileName) && (
              <button
                className="icon-btn room-settings-toggle"
                onClick={() => onRoomSettings(room)}
                aria-label={`${room.name} 设置`}
                aria-hidden={!expanded}
                tabIndex={expanded ? 0 : -1}
                disabled={!expanded}
              >
                <GearSix size={18} />
              </button>
            )}
          </div>
        ))}
        <button className="create-room" onClick={onCreate} aria-label="新建频道" title="新建频道">
          <span className="nav-action-icon" aria-hidden="true">
            <Plus size={20} />
          </span>
          <span className="nav-action-label" aria-hidden="true">新建频道</span>
        </button>
      </div>
      <button
        className="global-settings-button"
        onClick={onSettings}
        aria-label="设置"
        title="设置"
      >
        <span className="nav-action-icon" aria-hidden="true">
          <GearSix size={22} />
        </span>
        <span className="nav-action-label" aria-hidden="true">设置</span>
      </button>
    </aside>
  );
}
