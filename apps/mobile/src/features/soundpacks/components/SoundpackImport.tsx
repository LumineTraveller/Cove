import {useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {CoveButton} from '../../../components/CoveUi';
import {useThemedStyles} from '../../settings/ThemeProvider';
import type {CoveColors} from '../../settings/theme';
import {serverFetch} from '../../connection/serverSecurity';
import type {SoundboardController} from '../useSoundboard';
import {cancelOperations, pickAudioFiles, readAudioSelection, releaseAudioFiles, type SoundpackAudioFile} from '../soundpackFiles';
import {SoundpackAudioPlayer} from './SoundpackPlayer';

export const MAX_SOUNDPACK_BYTES = 8 * 1024 * 1024;
export function soundpackSelection(start: string, end: string, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return {start: 0, end: 0};
  if (!/^\d+(?:\.\d+)?$/.test(start.trim()) || !/^\d+(?:\.\d+)?$/.test(end.trim())) return null;
  const from = Number(start);
  const to = Number(end);
  return from >= 0 && to > from && to <= duration + 0.001 ? {start: from, end: Math.min(duration, to)} : null;
}
const seconds = (value: number) => String(Math.round(value * 1000) / 1000);

export function SoundpackImport({controller: board}: {controller: SoundboardController}) {
  const styles = useThemedStyles(createStyles);
  const [files, setFiles] = useState<SoundpackAudioFile[]>([]);
  const [index, setIndex] = useState(0);
  const [name, setName] = useState('');
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('0');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queueRef = useRef<SoundpackAudioFile[]>([]);
  const generation = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const summary = useRef({uploaded: 0, skipped: 0});
  const current = files[index];
  const selected = current ? soundpackSelection(start, end, current.duration) : null;
  const clear = () => {
    generation.current += 1;
    pending.current = false;
    const ids = queueRef.current.map(file => file.id);
    queueRef.current = [];
    cancelOperations().catch(() => undefined);
    releaseAudioFiles(ids).catch(() => undefined);
    if (mounted.current) {setFiles([]); setIndex(0); setBusy(false); setPreview(false); setError(null);}
  };
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; clearRef.current();};
  }, []);
  useEffect(() => {clearRef.current();}, [board.scope, board.ready]);
  const showFile = (file: SoundpackAudioFile, nextIndex: number) => {
    setIndex(nextIndex);
    setName(file.name.replace(/\.[^.]+$/, '').slice(0, 64));
    setStart('0'); setEnd(seconds(file.duration)); setPreview(false); setError(null);
  };
  const chooseFiles = async () => {
    if (!board.ready || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const token = ++generation.current;
    try {
      const selectedFiles = await pickAudioFiles();
      if (!mounted.current || generation.current !== token) {
        releaseAudioFiles(selectedFiles.map(file => file.id)).catch(() => undefined);
        return;
      }
      if (!selectedFiles.length) return;
      summary.current = {uploaded: 0, skipped: 0};
      queueRef.current = selectedFiles;
      setFiles(selectedFiles);
      showFile(selectedFiles[0], 0);
    } catch (cause) {
      if (mounted.current && generation.current === token) setError(cause instanceof Error ? cause.message : '音频选择失败，请重试');
    } finally {if (mounted.current && generation.current === token) {pending.current = false; setBusy(false);}}
  };
  const advance = () => {
    const next = index + 1;
    if (next < queueRef.current.length) showFile(queueRef.current[next], next);
    else {
      board.setNotice(`音频上传完成：成功 ${summary.current.uploaded} 个，跳过 ${summary.current.skipped} 个。`);
      clear();
    }
  };
  const upload = async () => {
    if (!board.ready || !current || !selected || !name.trim() || pending.current) return;
    pending.current = true;
    setBusy(true); setPreview(false); setError(null);
    const token = generation.current;
    const active = () => mounted.current && generation.current === token;
    try {
      const clip = await readAudioSelection(current.id, selected.start, selected.end);
      if (!active()) return;
      if (!clip.mimeType.startsWith('audio/') || clip.size <= 0 || clip.size > MAX_SOUNDPACK_BYTES) throw new Error('音频无效或超过 8MB，请缩短片段后重试');
      const response = await serverFetch(board.serverURL, '/api/soundpacks', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: name.trim(), data: clip.data, mimeType: clip.mimeType, socketId: board.socket.id, roomId: board.roomId}),
      });
      if (!active()) return;
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as {error?: string};
        throw new Error(result.error ?? `上传失败（HTTP ${response.status}）`);
      }
      summary.current.uploaded += 1;
      advance();
    } catch (cause) {if (active()) setError(cause instanceof Error ? cause.message : '音频上传失败，请重试');}
    finally {if (active()) {pending.current = false; setBusy(false);}}
  };
  return <View style={styles.container}>
    {current ? <>
      <Text style={styles.title}>上传音频 · {index + 1}/{files.length}</Text>
      <Text style={styles.file}>{current.name}</Text>
      <Text style={styles.hint}>{current.duration > 0 ? `时长 ${seconds(current.duration)} 秒 · ${(current.size / 1024 / 1024).toFixed(2)} MB` : '时长暂时不可用，仅可上传完整音频'}</Text>
      <Text style={styles.label}>语音包名称</Text><TextInput accessibilityLabel="上传语音包名称" style={styles.input}
        value={name} maxLength={64} onChangeText={setName} editable={!busy}/>
      {current.duration > 0 && <><View style={styles.range}>
        <View style={styles.rangeField}><Text style={styles.label}>开始时间（秒）</Text>
          <TextInput accessibilityLabel="音频开始时间（秒）" keyboardType="decimal-pad" style={styles.input} value={start}
            onChangeText={value => {setStart(value); setPreview(false);}} editable={!busy}/></View>
        <View style={styles.rangeField}><Text style={styles.label}>结束时间（秒）</Text>
          <TextInput accessibilityLabel="音频结束时间（秒）" keyboardType="decimal-pad" style={styles.input} value={end}
            onChangeText={value => {setEnd(value); setPreview(false);}} editable={!busy}/></View></View>
        {!selected && <Text style={styles.error}>输入有效的起止秒数，结束时间需大于开始时间且不超过音频时长。</Text>}
        <CoveButton title={preview ? '停止试听' : '试听片段'} tone="secondary" disabled={busy || !selected} onPress={() => setPreview(value => !value)}/>
        {preview && selected && <SoundpackAudioPlayer controller={board} playerKey={`${current.id}:${selected.start}:${selected.end}`}
          source={{uri: current.uri, cropStart: Math.round(selected.start * 1000), cropEnd: Math.round(selected.end * 1000)}}
          onEnd={() => setPreview(false)}
          onProgress={event => {if (event.currentTime >= selected.end - selected.start) setPreview(false);}}
          onError={() => {setPreview(false); setError('此音频无法试听，请检查音频输出设备或尝试上传完整文件。');}}/>}</>}
      <CoveButton title={busy ? '正在处理音频' : '确认并上传'} loading={busy} disabled={!board.ready || !selected || !name.trim()}
        onPress={() => {upload();}}/>
      <View style={styles.actions}><CoveButton title="跳过此音频" tone="secondary" disabled={busy} onPress={() => {summary.current.skipped += 1; advance();}}/>
        <CoveButton title="取消上传" tone="secondary" onPress={clear}/></View>
    </> : <><CoveButton title="上传音频" loading={busy} disabled={!board.ready} tone="secondary" onPress={() => {chooseFiles();}}/>
      <Text style={styles.hint}>可选择多个音频，逐个试听和裁剪。每个文件最多 8MB。</Text></>}
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </View>;
}
const createStyles = (colors: CoveColors) => StyleSheet.create({
  container: {gap: 10, marginVertical: 12}, title: {color: colors.text, fontSize: 14, fontWeight: '700'},
  file: {color: colors.textMuted, fontSize: 13, lineHeight: 18}, hint: {color: colors.textFaint, fontSize: 12, lineHeight: 18},
  label: {color: colors.textMuted, fontSize: 12, fontWeight: '600', marginBottom: 5},
  input: {minHeight: 48, paddingHorizontal: 11, borderRadius: 11, borderWidth: 1, borderColor: colors.borderStrong, color: colors.text, backgroundColor: colors.surface},
  range: {flexDirection: 'row', gap: 10}, rangeField: {flex: 1, minWidth: 0}, actions: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  error: {color: colors.red, fontSize: 13, lineHeight: 19},
});
