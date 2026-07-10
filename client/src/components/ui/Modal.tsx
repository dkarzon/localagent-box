import type { ReactNode } from 'react';
import { IconClose } from '../icons';
import { Button } from './Form';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, className = '' }: ModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-on-surface/40 p-4 pt-[10vh] backdrop-blur-sm">
      <div
        className={`relative w-full max-w-2xl rounded-lg border border-outline-variant bg-surface-lowest shadow-[0_8px_32px_rgba(26,27,35,0.12)] ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header className="card-header-rule flex items-center justify-between px-6 py-4">
          <h2 id="modal-title" className="text-lg font-medium text-on-surface">
            {title}
          </h2>
          <Button variant="ghost" className="!p-2" onClick={onClose} aria-label="Close">
            <IconClose className="size-4" />
          </Button>
        </header>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
