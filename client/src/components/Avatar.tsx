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
  return (
    <div className={`${sizes[size]} overflow-hidden rounded-full border border-white/15 bg-white/10 text-white flex flex-shrink-0 items-center justify-center font-semibold ${className}`}>
      {avatarUrl ? (
        <img src={avatarUrl} alt={`${username} 的头像`} className="h-full w-full object-cover" />
      ) : (
        <span aria-hidden="true">{username[0]?.toUpperCase() ?? '?'}</span>
      )}
    </div>
  );
}
