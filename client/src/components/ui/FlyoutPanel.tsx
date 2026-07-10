import { useEffect, type ReactNode } from 'react';
import { IconClose } from '../icons';
import { Button } from './Form';

interface FlyoutPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

const LG_MEDIA_QUERY = '(min-width: 1024px)';

export function FlyoutPanel({ open, onClose, title, children }: FlyoutPanelProps) {
  useEffect(() => {
    if (!open) return;

    const lgQuery = window.matchMedia(LG_MEDIA_QUERY);

    const syncWithViewport = () => {
      if (lgQuery.matches) {
        document.body.style.overflow = '';
        onClose();
      } else {
        document.body.style.overflow = 'hidden';
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    syncWithViewport();
    document.addEventListener('keydown', onKeyDown);
    lgQuery.addEventListener('change', syncWithViewport);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      lgQuery.removeEventListener('change', syncWithViewport);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <button
        type="button"
        className="absolute inset-0 bg-on-surface/40 backdrop-blur-sm"
        aria-label="Close panel"
        onClick={onClose}
      />
      <aside
        className="absolute bottom-0 right-0 top-0 flex w-full max-w-sm flex-col border-l border-outline-variant bg-surface-lowest shadow-[0_8px_32px_rgba(26,27,35,0.12)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="flyout-title"
      >
        <header className="card-header-rule flex shrink-0 items-center justify-between px-4 py-3">
          <h2 id="flyout-title" className="text-base font-medium text-on-surface">
            {title}
          </h2>
          <Button variant="ghost" className="!p-2" onClick={onClose} aria-label="Close">
            <IconClose className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>
  );
}
