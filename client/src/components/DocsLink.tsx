import { BookOpen } from './icons';

const DOCS_URL = 'https://github.com/HasinduNimesh/whisper-chat#readme';

/** Small fixed link to the project docs — deployment guide, setup, etc. */
export function DocsLink() {
  return (
    <a
      href={DOCS_URL}
      target="_blank"
      rel="noreferrer noopener"
      title="Documentation"
      aria-label="Open documentation"
      className="fixed bottom-3 right-3 z-50 flex items-center gap-1.5 rounded-full bg-wa-panel/90 px-3 py-1.5 text-xs font-medium text-wa-secondary shadow-lg ring-1 ring-wa-border backdrop-blur transition hover:text-wa-primary hover:ring-wa-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wa-green"
    >
      <BookOpen className="h-3.5 w-3.5" />
      Docs
    </a>
  );
}
