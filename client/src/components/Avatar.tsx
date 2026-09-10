import { avatarCropPresentation } from '../profile';

interface Props {
  username: string;
  avatarUrl?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const sizes = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-16 w-16 text-xl',
  xl: 'h-24 w-24 text-3xl',
};

export function Avatar({ username, avatarUrl, size = 'md', className = '' }: Props) {
  const hasAvatar = Boolean(avatarUrl);
  const crop = avatarUrl ? avatarCropPresentation(avatarUrl) : null;
  const fallbackClass = hasAvatar ? 'bg-white/10 text-white' : 'avatar-fallback';
  return (
    <div data-avatar-fallback={hasAvatar ? undefined : ''} className={`${sizes[size]} relative overflow-hidden rounded-full border border-white/15 ${fallbackClass} flex flex-shrink-0 items-center justify-center font-semibold ${className}`}>
      {avatarUrl ? (
        <img
          src={crop?.source ?? avatarUrl}
          alt={`${username} 的头像`}
          className="h-full w-full object-cover"
          style={crop ? {
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: `${crop.zoom * 100}%`,
            height: `${crop.zoom * 100}%`,
            maxWidth: 'none',
            maxHeight: 'none',
            objectFit: 'cover',
            transform: `translate(-50%, -50%) translate(${crop.offsetX * 100}%, ${crop.offsetY * 100}%)`,
          } : undefined}
        />
      ) : (
        <span aria-hidden="true">{username[0]?.toUpperCase() ?? '?'}</span>
      )}
    </div>
  );
}
