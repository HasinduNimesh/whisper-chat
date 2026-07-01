import type { ReactNode } from 'react';
import { ShieldAlert } from './icons';

/** Small shared building blocks for the app's simple centered modals
 * (identity export/import, contacts). Kept minimal on purpose. */

export const inputClass =
  'w-full rounded-lg bg-wa-input px-3 py-2 text-sm text-wa-primary outline-none ring-1 ring-transparent placeholder:text-wa-secondary focus-within:ring-2 focus-within:ring-wa-green';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm space-y-3 rounded-2xl bg-wa-panel p-5 shadow-2xl ring-1 ring-wa-border">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-wa-primary">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-full text-wa-secondary transition hover:bg-white/10 hover:text-wa-primary"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-2 text-[11px] text-red-300 ring-1 ring-red-500/20">
      <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="text-xs text-red-400">{children}</p>;
}

export function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-lg bg-wa-green py-2 text-sm font-semibold text-white transition hover:bg-wa-green-dark disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-full rounded-lg bg-wa-input py-2 text-sm font-medium text-wa-secondary transition hover:text-wa-primary"
    >
      {children}
    </button>
  );
}
