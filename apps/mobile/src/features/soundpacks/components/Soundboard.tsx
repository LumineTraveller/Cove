import {useEffect, useRef, useState, type ReactNode} from 'react';
import {ActivityIndicator, Alert, StyleSheet, Text, TextInput, TouchableOpacity, View} from 'react-native';
import {ArrowDown, ArrowUp, Download, MoreHorizontal, Play, Plus, Star, Volume2, X} from 'lucide-react-native';
import {CoveButton} from '../../../components/CoveUi';
import {InlineVolumeSlider} from '../../media/components/InlineVolumeSlider';
import {type CoveColors} from '../../settings/theme';
import {useCoveTheme, useThemedStyles} from '../../settings/ThemeProvider';
import {getProfileDisplayName, type ProfileRemarks} from '../../profiles/profileDisplayName';
import type {Soundpack} from '../../../types';
import type {SoundboardController} from '../useSoundboard';
import {SoundpackImport} from './SoundpackImport';
import {saveSoundpack} from '../soundpackFiles';
import {authorizedResourceURL} from '../../connection/serverSecurity';

interface Props {controller: SoundboardController; profileRemarks: ProfileRemarks; showHeading?: boolean; visible?: boolean;}
export function Soundboard({controller: board, profileRemarks, showHeading = true, visible = true}: Props) {
  const {colors} = useCoveTheme();
  const styles = useThemedStyles(createStyles);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const downloadPending = useRef(false);
  const downloadGeneration = useRef(0);
  useEffect(() => {
    downloadGeneration.current += 1;
    downloadPending.current = false;
    setDownloadingId(null);
    return () => {downloadGeneration.current += 1;};
  }, [visible, board.scope]);
  useEffect(() => { if (!visible) {setMenuId(null); setRenamingId(null);} }, [visible]);
  useEffect(() => {
    if (renamingId && !board.packs.some(pack => pack.id === renamingId && pack.canDelete)) setRenamingId(null);
    if (menuId && !board.packs.some(pack => pack.id === menuId)) setMenuId(null);
  }, [board.packs, renamingId, menuId]);
  if (!visible) return null;
  const packsById = new Map(board.packs.map(pack => [pack.id, pack]));
  const playDisabled = !board.ready || !board.inVoice;
  const download = async (sound: Soundpack) => {
    if (downloadPending.current) return;
    downloadPending.current = true;
    const token = downloadGeneration.current;
    setDownloadingId(sound.id);
    board.setNotice(null);
    try {
      const originalFilename = sound.originalFilename ?? sound.filename;
      const extension = originalFilename.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? '.audio';
      const safeName = Array.from(sound.name).map(character => character.charCodeAt(0) < 32 ? '_' : character).join('').replace(/[\\/:*?"<>|]/g, '_');
      const filename = `${safeName.slice(0, 100) || sound.id}${extension}`;
      const result = await saveSoundpack({url: authorizedResourceURL(board.serverURL, `/sounds/${encodeURIComponent(originalFilename)}`), filename, serverURL: board.serverURL});
      if (downloadGeneration.current === token && !result.cancelled) board.setNotice(`已保存「${sound.name}」`);
    } catch (cause) {if (downloadGeneration.current === token) board.setNotice(cause instanceof Error ? cause.message : '下载失败，请重试');}
    finally {if (downloadGeneration.current === token) {downloadPending.current = false; setDownloadingId(null);}}
  };
  const remove = (sound: Soundpack) => Alert.alert('删除语音包', `删除「${sound.name}」后，所有成员都将无法再播放。`, [
    {text: '取消', style: 'cancel'}, {text: '删除', style: 'destructive', onPress: () => {board.deleteSound(sound.id);}},
  ]);
  const control = (label: string, icon: ReactNode, onPress: () => void, disabled = false) => (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}}
      disabled={disabled} onPress={onPress} style={[styles.iconButton, disabled && styles.disabled]}>{icon}</TouchableOpacity>
  );
  return <View style={styles.card}>
    {showHeading && <View style={styles.heading}><View style={styles.headingIcon}><Volume2 size={18} color={colors.blue}/></View>
      <View style={styles.copy}><Text style={styles.title}>语音包</Text><Text style={styles.hint}>{board.inVoice ? '只对当前语音成员同步播放' : '加入语音后可播放，仍可管理语音包'}</Text></View></View>}
    <View style={styles.volumeHeader}><Text style={styles.label}>本机语音包音量</Text><Text style={styles.value}>{Math.round(board.volume * 100)}%</Text></View>
    <InlineVolumeSlider value={board.volume} label="本机语音包音量" onChange={board.updateVolume}/>
    <Text style={styles.hint}>音量和收藏仅影响此设备。</Text>
    {board.notice && <Text accessibilityRole="alert" style={styles.notice}>{board.notice}</Text>}
    <SoundpackImport controller={board}/>
    <View style={styles.groupToolbar}><Text style={styles.sectionTitle}>语音包分组</Text>
      <TouchableOpacity style={[styles.addGroup, (!board.canManage || !board.canAddGroup) && styles.disabled]}
        accessibilityRole="button" accessibilityLabel="添加语音包分组" accessibilityState={{disabled: !board.canManage || !board.canAddGroup}}
        disabled={!board.canManage || !board.canAddGroup} onPress={board.addSoundpackGroup}>
        <Plus size={16} color={colors.blue}/><Text style={styles.actionText}>添加分组</Text></TouchableOpacity></View>
    <Text style={styles.hint}>分组保存在本机当前账号；调整顺序会同步给所有成员。先填入空组，再添加下一组。</Text>
    {board.favorites.length > 0 && <View style={styles.favorites}><Text style={styles.sectionTitle}>快捷收藏 · {board.favorites.length}/6</Text>
      <View style={styles.quickList}>{board.favorites.map(id => {
        const sound = packsById.get(id);
        return sound ? <TouchableOpacity key={id} style={[styles.quickSound, playDisabled && styles.disabled]}
          accessibilityRole="button" accessibilityLabel={`播放收藏：${sound.name}`} disabled={playDisabled}
          onPress={() => {board.triggerSound(sound);}}><Star size={14} color={colors.blue} fill={colors.blue}/>
          <Text style={styles.quickName} numberOfLines={2}>{sound.name}</Text></TouchableOpacity> : null;
      })}</View></View>}
    {board.loading ? <View style={styles.empty}><ActivityIndicator color={colors.blue}/><Text style={styles.hint}>正在加载语音包</Text></View>
      : board.loadError ? <CoveButton title="重新加载语音包" tone="secondary" onPress={board.reload}/>
      : board.groups.map((group, groupIndex) => <View key={group.id} style={styles.group} testID={`soundpack-group-${group.id}`}>
        <View style={styles.groupHeader}><Text style={styles.sectionTitle}>分组 {groupIndex + 1}</Text><View style={styles.row}>
          {control(`上移分组 ${groupIndex + 1}`, <ArrowUp size={17} color={colors.textMuted}/>, () => {board.swapGroups(group.id, board.groups[groupIndex - 1].id);}, !board.canManage || groupIndex === 0)}
          {control(`下移分组 ${groupIndex + 1}`, <ArrowDown size={17} color={colors.textMuted}/>, () => {board.swapGroups(group.id, board.groups[groupIndex + 1].id);}, !board.canManage || groupIndex === board.groups.length - 1)}
        </View></View>
        {group.soundIds.length === 0 && <Text style={styles.emptyGroup}>{board.packs.length ? '空分组 · 在语音包操作中选择移入此组' : '当前还没有语音包，可以上传第一个音频'}</Text>}
        {group.soundIds.flatMap(id => packsById.get(id) ? [packsById.get(id)!] : []).map((sound, index) => {
          const playing = board.playback?.soundId === sound.id;
          const favorite = board.favorites.includes(sound.id);
          const expanded = menuId === sound.id;
          return <View key={sound.id} style={[styles.tile, playing && styles.tilePlaying]}><View style={styles.tileRow}>
            <TouchableOpacity style={[styles.tileMain, playDisabled && styles.disabled]} accessibilityRole="button"
              accessibilityLabel={`播放语音包：${sound.name}`} accessibilityState={{disabled: playDisabled}} disabled={playDisabled}
              onPress={() => {board.triggerSound(sound);}}><View style={[styles.playIcon, playing && styles.playIconActive]}>
              <Play size={15} color={playing ? colors.onPrimary : colors.textMuted}/></View><View style={styles.copy}>
              <Text style={styles.soundName} numberOfLines={2}>{sound.name}</Text><Text style={styles.uploader} numberOfLines={1}>
                {getProfileDisplayName(sound.uploader, sound.uploaderUserId, profileRemarks)}</Text></View></TouchableOpacity>
            <TouchableOpacity style={styles.iconButton} accessibilityRole="button" accessibilityLabel={`${favorite ? '取消收藏' : '收藏'}语音包：${sound.name}`}
              accessibilityState={{selected: favorite}} onPress={() => board.toggleFavorite(sound.id)}>
              <Star size={18} color={favorite ? colors.blue : colors.textFaint} fill={favorite ? colors.blue : 'transparent'}/></TouchableOpacity>
            {control(`语音包操作：${sound.name}`, expanded ? <X size={18} color={colors.textMuted}/> : <MoreHorizontal size={19} color={colors.textMuted}/>, () => setMenuId(expanded ? null : sound.id))}
          </View>
          {expanded && <View style={styles.menu}><View style={styles.actionRow}>
            <CoveButton title="上移" tone="secondary" disabled={!board.canManage || index === 0} onPress={() => {board.moveSound(sound.id, group.id, index - 1);}}/>
            <CoveButton title="下移" tone="secondary" disabled={!board.canManage || index === group.soundIds.length - 1} onPress={() => {board.moveSound(sound.id, group.id, index + 1);}}/></View>
            {board.groups.length > 1 && <><Text style={styles.label}>移到分组</Text><View style={styles.actionRow}>
              {board.groups.map((target, targetIndex) => <TouchableOpacity key={target.id} accessibilityRole="button"
                accessibilityLabel={`将${sound.name}移到分组 ${targetIndex + 1}`} accessibilityState={{selected: target.id === group.id}}
                style={[styles.groupChoice, target.id === group.id && styles.groupChoiceActive, !board.canManage && styles.disabled]}
                disabled={!board.canManage || target.id === group.id} onPress={() => {board.moveSound(sound.id, target.id, target.soundIds.length);}}>
                <Text style={styles.actionText}>分组 {targetIndex + 1}</Text></TouchableOpacity>)}
            </View></>}
            <CoveButton title={downloadingId === sound.id ? '保存中' : '下载原始音频'} tone="secondary" icon={<Download size={17} color={colors.textMuted}/>}
              disabled={!!downloadingId || !board.ready} onPress={() => {download(sound);}}/>
            {sound.canDelete && <View style={styles.actionRow}><CoveButton title="重命名" tone="secondary" disabled={!board.canManage}
              onPress={() => {setRenamingId(sound.id); setRenameValue(sound.name);}}/>
              <CoveButton title="删除语音包" tone="danger" disabled={!board.canManage} onPress={() => remove(sound)}/></View>}
          </View>}
          {renamingId === sound.id && <View style={styles.menu}><Text style={styles.label}>语音包名称</Text>
            <TextInput accessibilityLabel="语音包名称" value={renameValue} onChangeText={setRenameValue} maxLength={64}
              style={styles.input} placeholder="语音包名称" placeholderTextColor={colors.textFaint} returnKeyType="done" editable={board.canManage}/>
            <View style={styles.actionRow}><CoveButton title="取消重命名" tone="secondary" onPress={() => setRenamingId(null)}/>
              <CoveButton title="保存名称" disabled={!board.canManage || !renameValue.trim()} onPress={() => {
                const id = sound.id;
                board.renameSound(id, renameValue).then(saved => {if (saved) setRenamingId(current => current === id ? null : current);});
              }}/></View></View>}
          </View>;
        })}</View>)}
    {board.loadError && <Text style={styles.notice}>{board.loadError}</Text>}
    {board.busy && <Text accessibilityLiveRegion="polite" style={styles.hint}>正在保存，请稍候…</Text>}
  </View>;
}
const createStyles = (colors: CoveColors) => StyleSheet.create({
  card: {marginHorizontal: 14, marginBottom: 12, padding: 15, borderRadius: 19, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface},
  heading: {flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 13}, headingIcon: {width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blueSoft},
  copy: {flex: 1, minWidth: 0}, title: {color: colors.text, fontSize: 15, fontWeight: '700'},
  volumeHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8},
  label: {color: colors.textMuted, fontSize: 13, fontWeight: '600'}, value: {color: colors.blue, fontSize: 13, fontWeight: '700'},
  hint: {color: colors.textFaint, fontSize: 12, lineHeight: 18, marginBottom: 12}, notice: {color: colors.red, fontSize: 13, lineHeight: 19, marginVertical: 10},
  empty: {minHeight: 70, alignItems: 'center', justifyContent: 'center', gap: 8},
  groupToolbar: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 14},
  addGroup: {minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5}, sectionTitle: {color: colors.textMuted, fontSize: 13, fontWeight: '700'}, actionText: {color: colors.blue, fontSize: 13, fontWeight: '600'},
  favorites: {marginTop: 8, marginBottom: 16, gap: 9}, quickList: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  quickSound: {minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: colors.blueSoft, borderRadius: 12, padding: 10, maxWidth: '100%'}, quickName: {color: colors.text, fontSize: 13, flexShrink: 1},
  group: {gap: 8, paddingTop: 10, marginBottom: 14, borderTopWidth: 1, borderTopColor: colors.border}, groupHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, row: {flexDirection: 'row'},
  emptyGroup: {color: colors.textFaint, fontSize: 13, lineHeight: 20, paddingVertical: 16}, tile: {borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceRaised, overflow: 'hidden'},
  tilePlaying: {borderColor: colors.borderStrong, backgroundColor: colors.blueSoft}, tileRow: {flexDirection: 'row', alignItems: 'center'},
  tileMain: {flex: 1, minWidth: 0, minHeight: 65, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 9},
  playIcon: {width: 29, height: 29, borderRadius: 10, flexShrink: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface}, playIconActive: {backgroundColor: colors.blue},
  soundName: {color: colors.text, fontSize: 13, fontWeight: '700', lineHeight: 18}, uploader: {color: colors.textFaint, fontSize: 12, marginTop: 4}, iconButton: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  menu: {padding: 10, gap: 10, borderTopWidth: 1, borderTopColor: colors.border}, actionRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  groupChoice: {minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 11, borderWidth: 1, borderColor: colors.border}, groupChoiceActive: {backgroundColor: colors.blueSoft}, disabled: {opacity: 0.4},
  input: {minHeight: 48, borderRadius: 11, borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, color: colors.text, backgroundColor: colors.surface},
});
