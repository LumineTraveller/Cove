import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown, Hash, Headphones, MessageCircle, Monitor, Plus, Smartphone, Users } from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { CreateRoomDialog } from '../components/CreateRoomDialog';
import { socket } from '../socket';
import { useWebRTC } from '../hooks/useWebRTC';
import type { OnlineUser, Room, UserProfile } from '../types';
import type { AppTheme } from '../theme';
import { createRoomPayload } from '../roomSettings';
import {
  GlobalSettingsV2,
  NavigationRailV2,
  RoomAppearanceSettings,
  type GlobalSettingsPage,
  type RoomWithAppearance,
} from './ChatRoomV2';
import { UPDATE_CENTER_DETAILS_EVENT } from '../update';
import '../ui-v2.css';

interface Props {
  profile: UserProfile;
  onProfileChange: (profile: UserProfile) => void;
  accountId: string;
  onLogout: () => void;
  sessionReady: boolean;
  serverURL: string;
  theme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
}

interface LobbyPresenceSnapshot {
  ok: true;
  onlineUsers: OnlineUser[];
  roomMembers: Record<string, string[]>;
  voiceCounts: Record<string, number>;
}

export default function RoomList({ profile, onProfileChange, accountId, onLogout, sessionReady, serverURL, theme, onThemeChange }: Props) {
  const navigate = useNavigate();
  const rtc = useWebRTC(socket, '__lobby__');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMaxMembers, setNewMaxMembers] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [globalSettings, setGlobalSettings] = useState(false);
  const [globalSettingsPage, setGlobalSettingsPage] = useState<GlobalSettingsPage>('audio');
  const [roomSettings, setRoomSettings] = useState<RoomWithAppearance | null>(null);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [roomMembersMap, setRoomMembersMap] = useState<Record<string, string[]>>({});
  const [voiceCounts, setVoiceCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const handleUpdateDetails = () => {
      setGlobalSettingsPage('update');
      setGlobalSettings(true);
    };
    window.addEventListener(UPDATE_CENTER_DETAILS_EVENT, handleUpdateDetails);
    return () => window.removeEventListener(UPDATE_CENTER_DETAILS_EVENT, handleUpdateDetails);
  }, []);

  useEffect(() => {
    const onRooms = (updated: Room[]) => setRooms(updated);
    const onUsers = (users: OnlineUser[]) => setOnlineUsers(users);
    const onMembers = ({ roomId, members }: { roomId: string; members: string[] }) => setRoomMembersMap(previous => ({ ...previous, [roomId]: members }));
    const onVoiceCounts = (counts: Record<string, number>) => setVoiceCounts(counts);
    socket.on('rooms:updated', onRooms);
    socket.on('users:online', onUsers);
    socket.on('room:members:global', onMembers);
    socket.on('voice:counts', onVoiceCounts);
    return () => {
      socket.off('rooms:updated', onRooms);
      socket.off('users:online', onUsers);
      socket.off('room:members:global', onMembers);
      socket.off('voice:counts', onVoiceCounts);
    };
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    let active = true;
    socket.timeout(5_000).emit('presence:get', (
      error: Error | null,
      snapshot?: LobbyPresenceSnapshot,
    ) => {
      if (!active || error || !snapshot?.ok) return;
      setOnlineUsers(snapshot.onlineUsers);
      setRoomMembersMap(snapshot.roomMembers);
      setVoiceCounts(snapshot.voiceCounts);
    });
    return () => { active = false; };
  }, [sessionReady]);

  useEffect(() => {
    if (!sessionReady) return;
    fetch(`${serverURL}/api/rooms`)
      .then(response => response.json())
      .then((data: Room[]) => setRooms(data));
  }, [serverURL, sessionReady]);

  const createRoom = async () => {
    if (!newName.trim() || !sessionReady || creatingRoom) return;
    setCreatingRoom(true);
    try {
      const result = await new Promise<{ room?: Room; error?: string }>((resolve, reject) => {
        socket.timeout(5_000).emit('room:create', createRoomPayload(newName, newMaxMembers, newPassword), (error: Error | null, response: { room?: Room; error?: string }) => error ? reject(error) : resolve(response));
      });
      if (!result.room) throw new Error(result.error ?? '创建失败');
      setNewName('');
      setNewMaxMembers('');
      setNewPassword('');
      setCreating(false);
      navigate(`/room/${result.room.id}`);
    } catch (error) {
      alert(`创建失败：${error instanceof Error ? error.message : String(error)}\n${serverURL}`);
    } finally { setCreatingRoom(false); }
  };

  const lobbyRooms: RoomWithAppearance[] = rooms.map((room) => ({
    ...room,
    count: voiceCounts[room.id] ?? 0,
    isOwner: room.isOwner ?? room.ownerName === profile.username,
  }));
  const inputVolume = rtc.microphoneVolume * 100;
  const outputVolume = rtc.masterOutputVolume * 100;
  const setInputVolume = (value: number) => rtc.setMicrophoneVolume(value / 100);
  const setOutputVolume = (value: number) => rtc.setMasterOutputVolume(value / 100);

  const applyRoomSettings = (changes: Record<string, unknown>) => {
    if (!roomSettings) return;
    socket.timeout(5_000).emit(
      'room:update-settings',
      { roomId: roomSettings.id, ...changes },
      (error: Error | null, response?: { ok?: boolean; room?: RoomWithAppearance; error?: string }) => {
        if (error || !response?.ok) {
          alert(response?.error ?? error?.message ?? '设置保存失败');
          return;
        }
        if (response.room) {
          setRooms((current) => current.map((item) => item.id === response.room!.id ? response.room! : item));
        }
        setRoomSettings(null);
      },
    );
  };

  const deleteRoom = () => {
    const targetRoomId = roomSettings?.id;
    if (!targetRoomId) return;
    socket.timeout(5_000).emit(
      'room:delete',
      { roomId: targetRoomId },
      (error: Error | null, response?: { ok?: boolean; error?: string }) => {
        if (error || !response?.ok) {
          alert(response?.error ?? error?.message ?? '删除频道失败');
          return;
        }
        setRooms((current) => current.filter((item) => item.id !== targetRoomId));
        setRoomSettings((current) => current?.id === targetRoomId ? null : current);
      },
    );
  };

  return (
    <main className="prototype-page cove-v2-page lobby-page">
      <div className="lobby-shell">
        <NavigationRailV2
          rooms={lobbyRooms}
          activeRoom=""
          profileName={profile.username}
          onRoom={(id) => navigate(`/room/${id}`)}
          expanded
          setExpanded={() => undefined}
          onSettings={() => {
            setGlobalSettingsPage('audio');
            setGlobalSettings(true);
          }}
          onRoomSettings={setRoomSettings}
          onCreate={() => setCreating(true)}
          showCollapse={false}
          className="lobby-navigation-rail"
        />

        <section className="lobby-workspace">
          <header className="lobby-header">
            <h1>Cove 频道大厅</h1>
          </header>

          <div className="lobby-content">
            <section className="lobby-hero">
              <span className="lobby-hero-icon">
                <MessageCircle size={34} />
              </span>
              <div>
                <small>欢迎回来</small>
                <h2>今天想去哪一个频道？</h2>
                <p>从左侧快速进入频道，或从下面的概览查看当前房间状态。</p>
              </div>
              <button
                className="lobby-create-button"
                onClick={() => setCreating(true)}
                disabled={!sessionReady}
              >
                <Plus size={18} />
                创建频道
              </button>
            </section>

            <section className="lobby-stat-grid" aria-label="服务器概览">
              <article className="lobby-stat-card">
                <span>频道</span>
                <strong>{rooms.length}</strong>
                <small>可加入的空间</small>
              </article>
              <article className="lobby-stat-card">
                <span>在线成员</span>
                <strong>{onlineUsers.length}</strong>
                <small>当前服务器</small>
              </article>
              <article className="lobby-stat-card accent">
                <span>语音中</span>
                <strong>
                  {Object.values(voiceCounts).reduce(
                    (total, count) => total + count,
                    0,
                  )}
                </strong>
                <small>正在交谈</small>
              </article>
            </section>

            <section className="lobby-section">
              <div className="lobby-section-heading">
                <div>
                  <small>频道概览</small>
                  <h2>最近的空间</h2>
                </div>
                <span>{rooms.length} 个频道</span>
              </div>
              {rooms.length ? (
                <div className="lobby-room-grid">
                  {rooms.map((room) => (
                    <button
                      className="lobby-room-card"
                      key={room.id}
                      onClick={() => navigate(`/room/${room.id}`)}
                    >
                      <span className="lobby-room-card-avatar">
                        {room.avatarUrl ? (
                          <img src={room.avatarUrl} alt="" />
                        ) : (
                          room.name.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <span className="lobby-room-card-copy">
                        <b>
                          <Hash size={16} />
                          {room.name}
                        </b>
                        <small>
                          <Crown size={14} />
                          {room.ownerName ?? "暂无房主"}
                        </small>
                      </span>
                      <span className="lobby-room-card-counts">
                        <span title="语音人数">
                          <Headphones size={15} />
                          {voiceCounts[room.id] ?? 0}
                        </span>
                        <span title="频道人数">
                          <Users size={15} />
                          {roomMembersMap[room.id]?.length ?? 0}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="lobby-empty-card">创建第一个频道，开始和朋友聊天。</div>
              )}
            </section>

            <section className="lobby-section lobby-online-section">
              <div className="lobby-section-heading">
                <div>
                  <small>实时状态</small>
                  <h2>在线成员</h2>
                </div>
                <span>{onlineUsers.length} 人在线</span>
              </div>
              {onlineUsers.length ? (
                <div className="lobby-member-grid">
                  {onlineUsers.map((user) => {
                    const isSelf = user.socketId === socket.id;
                    return (
                      <div className="lobby-member-card" key={user.socketId}>
                        <span className="lobby-member-avatar">
                          <Avatar
                            username={user.username}
                            avatarUrl={user.avatarUrl}
                            size="md"
                          />
                          <i />
                        </span>
                        <span className="lobby-member-copy">
                          <b>{isSelf ? `${user.username}（你）` : user.username}</b>
                          <small>
                            在线 · {user.platform === "mobile" ? "手机端" : "电脑端"}
                          </small>
                        </span>
                        {user.platform === "mobile" ? (
                          <Smartphone size={18} />
                        ) : (
                          <Monitor size={18} />
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="lobby-empty-card">当前还没有其他成员在线。</div>
              )}
            </section>
          </div>
        </section>
      </div>

      {creating && (
        <CreateRoomDialog
          name={newName}
          maxMembers={newMaxMembers}
          password={newPassword}
          submitting={creatingRoom}
          submitDisabled={!sessionReady}
          onName={setNewName}
          onMaxMembers={setNewMaxMembers}
          onPassword={setNewPassword}
          onSubmit={() => void createRoom()}
          onClose={() => {
            setCreating(false);
            setNewName('');
            setNewMaxMembers('');
            setNewPassword('');
          }}
        />
      )}

      {roomSettings && (
        <RoomAppearanceSettings
          room={roomSettings}
          onSave={applyRoomSettings}
          onClose={() => setRoomSettings(null)}
          onDelete={deleteRoom}
          theme={theme}
        />
      )}
      {globalSettings && (
        <GlobalSettingsV2
          profile={profile}
          accountId={accountId}
          onProfileChange={onProfileChange}
          onLogout={onLogout}
          inputVolume={inputVolume}
          outputVolume={outputVolume}
          setInputVolume={setInputVolume}
          setOutputVolume={setOutputVolume}
          rtc={rtc}
          initialPage={globalSettingsPage}
          onClose={() => setGlobalSettings(false)}
          theme={theme}
          onThemeChange={onThemeChange}
        />
      )}
    </main>
  );
}
