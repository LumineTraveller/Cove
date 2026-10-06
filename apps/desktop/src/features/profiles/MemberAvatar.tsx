import {
  Desktop,
  DeviceMobile,
  Microphone,
  MicrophoneSlash,
  MonitorPlay,
  Waveform,
} from '@phosphor-icons/react';
import { Avatar } from './components/Avatar';
import type { RoomMember } from '../../types';

export function DeviceBadge({ platform }: { platform?: string | null }) {
  if (platform !== 'mobile' && platform !== 'desktop') return null;
  return (
    <span className="device-badge" title={platform === 'mobile' ? '手机端' : '电脑端'}>
      {platform === 'mobile' ? (
        <DeviceMobile size={10} weight="fill" />
      ) : (
        <Desktop size={10} weight="fill" />
      )}
    </span>
  );
}

export function MemberAvatar({
  member,
  speaking = false,
  inVoice = false,
}: {
  member: RoomMember;
  speaking?: boolean;
  inVoice?: boolean;
}) {
  return (
    <span className="member-avatar">
      <Avatar
        username={member.username}
        avatarUrl={member.avatarUrl}
        size="sm"
        className={speaking ? 'avatar-core speaking' : 'avatar-core'}
      />
      {inVoice && (
        <span
          className={`mic-badge ${member.isMuted ? 'off' : 'on'}`}
          title={member.isMuted ? '已闭麦' : '已开麦'}
        >
          {member.isMuted ? (
            <MicrophoneSlash size={10} weight="bold" />
          ) : (
            <Microphone size={10} weight="fill" />
          )}
        </span>
      )}
      <DeviceBadge platform={member.platform} />
    </span>
  );
}

export function SharedBadges({ screen, audio }: { screen?: boolean; audio?: boolean }) {
  if (!screen && !audio) return null;
  return (
    <span className="shared-badges" aria-label="正在共享媒体">
      {screen && (
        <MonitorPlay
          className="screen-share-badge"
          size={15}
          weight="fill"
          aria-label="正在共享屏幕"
        />
      )}
      {audio && (
        <Waveform className="audio-share-badge" size={15} weight="bold" aria-label="正在共享音频" />
      )}
    </span>
  );
}
