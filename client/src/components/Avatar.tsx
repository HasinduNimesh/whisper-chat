import { avatarGradient, initial } from '../lib/avatar';

const SIZES = {
  sm: 'h-7 w-7 text-xs',
  md: 'h-9 w-9 text-sm',
  lg: 'h-11 w-11 text-base',
} as const;

interface AvatarProps {
  name: string;
  size?: keyof typeof SIZES;
  /** Show a green presence dot in the corner. */
  online?: boolean;
  /** Subtle accent ring (e.g. to mark yourself). */
  ring?: boolean;
}

/** A colored, name-derived avatar with optional presence dot. */
export function Avatar({ name, size = 'md', online = false, ring = false }: AvatarProps) {
  return (
    <div className="relative shrink-0">
      <div
        className={`flex items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white shadow-sm ${
          SIZES[size]
        } ${avatarGradient(name)} ${ring ? 'ring-2 ring-accent/60' : ''}`}
      >
        {initial(name)}
      </div>
      {online && (
        <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-ink-800" />
      )}
    </div>
  );
}
