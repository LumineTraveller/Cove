import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Socket } from 'socket.io-client';
import { AlertTriangle, GripVertical, LayoutGrid, LoaderCircle, Pause, Pencil, Play, Save, Trash2, Upload, Volume2, X } from 'lucide-react';

interface Soundpack { id: string; name: string; filename: string; uploader: string; createdAt: number; sortOrder: number; canDelete: boolean }
interface Props { socket: Socket; roomId: string; serverURL: string; disabled?: boolean }

const SOUNDPACK_VOLUME_KEY = 'cove:soundpack-volume';

function loadSoundpackVolume() {
  try {
    const stored = localStorage.getItem(SOUNDPACK_VOLUME_KEY);
    if (stored === null) return 100;
    const value = Number(stored);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100;
  } catch {
    return 100;
  }
}

function applySoundpackOrder(packs: Soundpack[], orderedIds: string[]) {
  const byId = new Map(packs.map(pack => [pack.id, pack]));
  const ordered = orderedIds.flatMap(id => {
    const pack = byId.get(id);
    if (!pack) return [];
    byId.delete(id);
    return [pack];
  });
  return [...ordered, ...byId.values()];
}

export function SoundPackPanel({ socket, roomId, serverURL, disabled = false }: Props) {
  const [packs, setPacks] = useState<Soundpack[]>([]);
  const [uploading, setUploading] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Soundpack | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingRename, setPendingRename] = useState<Soundpack | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [soundpackVolume, setSoundpackVolume] = useState(loadSoundpackVolume);
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const soundpackVolumeRef = useRef(soundpackVolume);
  const packsRef = useRef<Soundpack[]>([]);
  useEffect(() => { packsRef.current = packs; }, [packs]);

  const updateSoundpackVolume = (value: number) => {
    const normalized = Math.min(100, Math.max(0, value));
    soundpackVolumeRef.current = normalized;
    setSoundpackVolume(normalized);
    if (audioRef.current) audioRef.current.volume = normalized / 100;
    try { localStorage.setItem(SOUNDPACK_VOLUME_KEY, String(normalized)); } catch { /* 本地存储不可用时仍保留本次会话设置。 */ }
  };

  useEffect(() => {
    if (disabled || !socket.id) return;
    fetch(`${serverURL}/api/soundpacks?socketId=${encodeURIComponent(socket.id)}&roomId=${encodeURIComponent(roomId)}`)
      .then(response => response.json()).then((list: Soundpack[]) => setPacks(list)).catch(() => undefined);
  }, [serverURL, socket, roomId, disabled]);

  const playSound = useCallback((soundId: string) => {
    const sound = packsRef.current.find(pack => pack.id === soundId);
    if (!sound) return;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; }
    const audio = new Audio(`${serverURL}/sounds/${sound.filename}`);
    audio.volume = soundpackVolumeRef.current / 100;
    audioRef.current = audio;
    setPlayingId(soundId);
    audio.play().catch(() => setPlayingId(null));
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => setPlayingId(null);
  }, [serverURL]);

  useEffect(() => {
    const onAdded = (sound: Soundpack) => setPacks(previous => [sound, ...previous]);
    const onPlay = ({ soundId }: { soundId: string }) => playSound(soundId);
    const onDeleted = ({ soundId }: { soundId: string }) => {
      setPacks(previous => previous.filter(sound => sound.id !== soundId));
      setPlayingId(current => {
        if (current !== soundId) return current;
        audioRef.current?.pause();
        if (audioRef.current) audioRef.current.src = '';
        return null;
      });
      setPendingDelete(current => current?.id === soundId ? null : current);
      setPendingRename(current => current?.id === soundId ? null : current);
    };
    const onRenamed = ({ soundId, name }: { soundId: string; name: string }) => {
      setPacks(previous => previous.map(sound => sound.id === soundId ? { ...sound, name } : sound));
      setPendingRename(current => current?.id === soundId ? { ...current, name } : current);
    };
    const onReordered = ({ orderedIds }: { orderedIds: string[] }) => {
      setPacks(previous => applySoundpackOrder(previous, orderedIds));
    };
    socket.on('soundpack:added', onAdded);
    socket.on('soundpack:play', onPlay);
    socket.on('soundpack:deleted', onDeleted);
    socket.on('soundpack:renamed', onRenamed);
    socket.on('soundpack:reordered', onReordered);
    return () => { socket.off('soundpack:added', onAdded); socket.off('soundpack:play', onPlay); socket.off('soundpack:deleted', onDeleted); socket.off('soundpack:renamed', onRenamed); socket.off('soundpack:reordered', onReordered); };
  }, [socket, playSound]);

  const handlePlay = (sound: Soundpack) => {
    if (disabled) return;
    playSound(sound.id);
    socket.emit('soundpack:play', { soundId: sound.id, roomId });
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('audio/')) { alert('请选择音频文件'); return; }
    if (file.size > 8 * 1024 * 1024) { alert('文件过大，最大支持 8MB'); return; }
    setUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.slice(index, index + 8192));
      const response = await fetch(`${serverURL}/api/soundpacks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, ''), data: btoa(binary), mimeType: file.type, socketId: socket.id, roomId }),
      });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error ?? '上传失败'); }
    } catch (cause) {
      alert(cause instanceof Error ? cause.message : '上传失败，请检查网络连接');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const deleteSound = async () => {
    if (!pendingDelete || disabled) return;
    const target = pendingDelete;
    setDeletingId(target.id);
    try {
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        socket.timeout(5_000).emit('soundpack:delete', { soundId: target.id, roomId }, (error: Error | null, response: { ok: boolean; error?: string }) => error ? reject(error) : resolve(response));
      });
      if (!result.ok) throw new Error(result.error ?? '删除失败');
      setPacks(previous => previous.filter(sound => sound.id !== target.id));
      setPendingDelete(null);
    } catch (cause) {
      alert(cause instanceof Error ? cause.message : '删除失败，请检查网络连接');
    } finally {
      setDeletingId(null);
    }
  };

  const beginRename = (sound: Soundpack) => {
    setPendingRename(sound);
    setRenameValue(sound.name);
  };

  const renameSound = async () => {
    if (!pendingRename || disabled || !renameValue.trim()) return;
    const target = pendingRename;
    setRenamingId(target.id);
    try {
      const result = await new Promise<{ ok: boolean; error?: string; name?: string }>((resolve, reject) => {
        socket.timeout(5_000).emit('soundpack:rename', {
          soundId: target.id,
          roomId,
          name: renameValue.trim(),
        }, (error: Error | null, response: { ok: boolean; error?: string; name?: string }) => error ? reject(error) : resolve(response));
      });
      if (!result.ok) throw new Error(result.error ?? '改名失败');
      const nextName = result.name ?? renameValue.trim();
      setPacks(previous => previous.map(sound => sound.id === target.id ? { ...sound, name: nextName } : sound));
      setPendingRename(null);
    } catch (cause) {
      alert(cause instanceof Error ? cause.message : '改名失败，请检查网络连接');
    } finally {
      setRenamingId(null);
    }
  };

  const reorderSound = async (sourceId: string, targetId: string) => {
    if (disabled || reordering || sourceId === targetId) return;
    const previous = packsRef.current;
    const sourceIndex = previous.findIndex(sound => sound.id === sourceId);
    const targetIndex = previous.findIndex(sound => sound.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;

    const next = [...previous];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    setPacks(next);
    setReordering(true);
    try {
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        socket.timeout(5_000).emit('soundpack:reorder', {
          roomId,
          orderedIds: next.map(sound => sound.id),
        }, (error: Error | null, response: { ok: boolean; error?: string }) => error ? reject(error) : resolve(response));
      });
      if (!result.ok) throw new Error(result.error ?? '调整顺序失败');
    } catch (cause) {
      setPacks(previous);
      alert(cause instanceof Error ? cause.message : '调整顺序失败，请检查网络连接');
    } finally {
      setReordering(false);
    }
  };

  return (
    <>
      <div className="flex-shrink-0 border-t border-white/[0.08] p-3">
        <button onClick={() => setOpen(true)} disabled={disabled} className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2.5 text-left text-white/60 transition hover:border-cyan-300/25 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300/40 disabled:cursor-not-allowed disabled:opacity-35">
          <LayoutGrid size={18} /><span className="flex-1 font-medium">语音包</span><span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/40">{packs.length}</span>
        </button>
      </div>

      {open && createPortal((
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/65 p-6 backdrop-blur-md" onMouseDown={() => setOpen(false)}>
          <section className="relative flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/15 bg-zinc-900/95 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="soundpack-title">
            <header className="flex items-center gap-3 border-b border-white/10 px-6 py-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-300/10 text-cyan-200"><Volume2 size={20} /></div>
              <div className="min-w-0 flex-1"><h2 id="soundpack-title" className="text-lg font-bold text-white">房间语音包</h2><p className="text-sm text-white/40">点击同步播放，拖动方格调整所有成员看到的顺序</p></div>
              <button onClick={() => fileInputRef.current?.click()} disabled={uploading || disabled} className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-3.5 py-2.5 text-sm font-medium text-white/65 transition hover:bg-white/15 hover:text-white disabled:opacity-35"><Upload size={17} />{uploading ? '上传中' : '上传音频'}</button>
              <button onClick={() => setOpen(false)} className="rounded-xl p-2.5 text-white/40 transition hover:bg-white/10 hover:text-white" aria-label="关闭语音包"><X size={19} /></button>
              <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleFileChange} />
            </header>

            <div className="flex items-center gap-3 border-b border-white/[0.08] bg-black/10 px-6 py-3">
              <Volume2 size={17} className="flex-shrink-0 text-white/45" />
              <label htmlFor="soundpack-volume" className="whitespace-nowrap text-sm font-medium text-white/65">语音包音量</label>
              <input
                id="soundpack-volume"
                type="range"
                min="0"
                max="100"
                step="5"
                value={soundpackVolume}
                onChange={event => updateSoundpackVolume(Number(event.target.value))}
                className="h-1.5 min-w-24 flex-1 cursor-pointer accent-cyan-300"
                aria-label="本机语音包音量"
              />
              <span className="w-10 text-right text-sm tabular-nums text-cyan-100/75">{soundpackVolume}%</span>
              <span className="hidden text-xs text-white/30 sm:inline">仅影响此设备</span>
            </div>

            <div className="overflow-y-auto p-5">
              {packs.length === 0 ? (
                <button onClick={() => fileInputRef.current?.click()} className="flex min-h-52 w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/15 text-white/35 transition hover:border-cyan-300/35 hover:bg-cyan-300/[0.04] hover:text-white/70"><Upload size={28} /><span className="font-medium">上传第一个语音包</span><span className="text-sm text-white/25">最大 8MB</span></button>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {packs.map(sound => {
                    const playing = playingId === sound.id;
                    return (
                      <div
                        key={sound.id}
                        draggable={!disabled && !reordering && packs.length > 1}
                        onDragStart={event => {
                          setDraggedId(sound.id);
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', sound.id);
                        }}
                        onDragOver={event => {
                          if (draggedId && draggedId !== sound.id) {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                          }
                        }}
                        onDrop={event => {
                          event.preventDefault();
                          const sourceId = event.dataTransfer.getData('text/plain') || draggedId;
                          setDraggedId(null);
                          if (sourceId) void reorderSound(sourceId, sound.id);
                        }}
                        onDragEnd={() => setDraggedId(null)}
                        className={`group relative min-h-20 ${packs.length > 1 && !disabled ? 'cursor-grab active:cursor-grabbing' : ''} ${draggedId === sound.id ? 'opacity-45' : ''}`}
                      >
                        <button onClick={() => handlePlay(sound)} disabled={disabled} className={`relative h-full min-h-20 w-full overflow-hidden rounded-2xl border px-4 py-3 text-left transition-all focus:outline-none focus:ring-2 focus:ring-cyan-300/50 disabled:opacity-35 ${sound.canDelete ? 'pr-20' : ''} ${playing ? 'border-cyan-300/50 bg-cyan-300/15 text-cyan-100 shadow-lg shadow-cyan-950/30' : 'border-white/[0.07] bg-white/[0.055] text-white/75 hover:-translate-y-0.5 hover:border-cyan-300/25 hover:bg-white/10 hover:text-white'}`} title="点击同步播放">
                          <span className="flex items-start gap-3"><span className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl ${playing ? 'bg-cyan-200 text-zinc-900' : 'bg-white/10 text-white/45 group-hover:bg-cyan-300/10 group-hover:text-cyan-100'}`}>{playing ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}</span><span className="min-w-0"><span className="block truncate text-sm font-semibold">{sound.name}</span><span className="mt-1 block truncate text-xs text-white/30">{sound.uploader}</span></span></span>
                          {playing && <span className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-cyan-300" />}
                        </button>
                        {sound.canDelete && (
                          <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            <button onClick={() => beginRename(sound)} disabled={disabled || renamingId === sound.id} className="rounded-lg bg-zinc-900/80 p-2 text-white/45 backdrop-blur transition hover:bg-cyan-500/20 hover:text-cyan-200 focus:outline-none focus:ring-2 focus:ring-cyan-300/40 disabled:opacity-30" aria-label={`重命名语音包 ${sound.name}`} title="重命名"><Pencil size={15} /></button>
                            <button onClick={() => setPendingDelete(sound)} disabled={disabled || deletingId === sound.id} className="rounded-lg bg-zinc-900/80 p-2 text-white/45 backdrop-blur transition hover:bg-red-500/20 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-red-300/40 disabled:opacity-30" aria-label={`删除语音包 ${sound.name}`} title="删除">{deletingId === sound.id ? <LoaderCircle size={15} className="animate-spin" /> : <Trash2 size={15} />}</button>
                          </div>
                        )}
                        {packs.length > 1 && (
                          <span className="pointer-events-none absolute bottom-2 right-2 z-10 rounded-lg bg-zinc-950/65 p-1 text-white/25 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100" aria-hidden="true"><GripVertical size={14} /></span>
                        )}
                      </div>
                    );
                  })}
                  <button onClick={() => fileInputRef.current?.click()} disabled={uploading || disabled} className="flex min-h-20 items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 text-sm font-medium text-white/35 transition hover:border-cyan-300/35 hover:bg-cyan-300/[0.04] hover:text-cyan-100 disabled:opacity-35">{uploading ? <LoaderCircle size={18} className="animate-spin" /> : <Upload size={18} />} 上传</button>
                </div>
              )}
            </div>
            {pendingRename && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
                <form className="w-full max-w-sm rounded-3xl border border-cyan-300/20 bg-zinc-900 p-6 shadow-2xl" onSubmit={event => { event.preventDefault(); renameSound(); }}>
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-200"><Pencil size={21} /></div>
                  <h3 className="mt-4 text-lg font-bold text-white">重命名语音包</h3>
                  <p className="mt-1 text-sm text-white/40">音频文件不会改变，只更新所有成员看到的名称。</p>
                  <input autoFocus maxLength={64} value={renameValue} onChange={event => setRenameValue(event.target.value)} className="mt-4 w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-white outline-none transition placeholder:text-white/20 focus:border-cyan-300/40 focus:ring-2 focus:ring-cyan-300/15" placeholder="语音包名称" />
                  <div className="mt-5 flex gap-2.5"><button type="button" onClick={() => setPendingRename(null)} disabled={renamingId === pendingRename.id} className="flex-1 rounded-xl bg-white/10 py-2.5 font-medium text-white/70 transition hover:bg-white/15 disabled:opacity-35">取消</button><button type="submit" disabled={renamingId === pendingRename.id || !renameValue.trim()} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-200 py-2.5 font-semibold text-zinc-900 transition hover:bg-cyan-100 disabled:opacity-40">{renamingId === pendingRename.id ? <LoaderCircle size={17} className="animate-spin" /> : <Save size={17} />}保存</button></div>
                </form>
              </div>
            )}
            {pendingDelete && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
                <div className="w-full max-w-sm rounded-3xl border border-red-400/20 bg-zinc-900 p-6 shadow-2xl" role="alertdialog" aria-modal="true" aria-labelledby="delete-sound-title">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-500/15 text-red-300"><AlertTriangle size={21} /></div>
                  <h3 id="delete-sound-title" className="mt-4 text-lg font-bold text-white">删除“{pendingDelete.name}”？</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/45">音频文件会从服务器永久删除，所有在线成员的语音包列表也会同步更新。</p>
                  <div className="mt-5 flex gap-2.5"><button onClick={() => setPendingDelete(null)} disabled={deletingId === pendingDelete.id} className="flex-1 rounded-xl bg-white/10 py-2.5 font-medium text-white/70 transition hover:bg-white/15 disabled:opacity-35">取消</button><button onClick={deleteSound} disabled={deletingId === pendingDelete.id} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-500 py-2.5 font-semibold text-white transition hover:bg-red-400 disabled:opacity-50">{deletingId === pendingDelete.id ? <LoaderCircle size={17} className="animate-spin" /> : <Trash2 size={17} />}确认删除</button></div>
                </div>
              </div>
            )}
          </section>
        </div>
      ), document.body)}
    </>
  );
}
