/**
 * Deterministic, name-derived avatar colors so each person reads as the same
 * hue everywhere (roster, messages, call tiles) without storing anything.
 */

// Full literal class strings so Tailwind's JIT scanner keeps them in the build.
const GRADIENTS = [
  'from-emerald-400 to-teal-500',
  'from-sky-400 to-indigo-500',
  'from-fuchsia-400 to-purple-500',
  'from-amber-400 to-orange-500',
  'from-rose-400 to-pink-500',
  'from-cyan-400 to-blue-500',
  'from-lime-400 to-emerald-500',
  'from-violet-400 to-indigo-500',
];

function hash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

export function avatarGradient(name: string): string {
  return GRADIENTS[hash(name || '?') % GRADIENTS.length];
}

export function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

// WhatsApp gives each group participant a distinct name color. Literal classes
// so Tailwind's JIT keeps them.
const NAME_COLORS = [
  'text-emerald-300',
  'text-sky-300',
  'text-fuchsia-300',
  'text-amber-300',
  'text-rose-300',
  'text-cyan-300',
  'text-lime-300',
  'text-violet-300',
];

export function nameColor(name: string): string {
  return NAME_COLORS[hash(name || '?') % NAME_COLORS.length];
}
