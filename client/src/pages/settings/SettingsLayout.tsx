import { Link, useLocation } from 'react-router-dom';
import { IconCheck, IconLock } from '../../components/icons';
import { Button } from '../../components/ui/Form';
import { StatusMessage } from '../../components/ui/StatusMessage';
import { PAGE_SUBTITLES, PAGE_TITLES, settingsSections } from '../../navigation';
import type { StatusVariant } from '../../api/types';

interface SettingsLayoutProps {
  children: React.ReactNode;
  formId: string;
  status: string;
  statusVariant: StatusVariant;
  configLoaded: boolean;
  onDiscard: () => void;
}

export function SettingsLayout({
  children,
  formId,
  status,
  statusVariant,
  configLoaded,
  onDiscard,
}: SettingsLayoutProps) {
  const location = useLocation();

  return (
    <>
      <div className="mx-auto max-w-5xl overflow-x-hidden px-6 py-6 pb-32">
        <header className="mb-8">
          <h2 className="headline-lg text-primary">{PAGE_TITLES.settings}</h2>
          <p className="mt-1 max-w-2xl body-md text-on-surface-variant">{PAGE_SUBTITLES.settings}</p>
        </header>

        <nav className="mb-8 flex flex-wrap gap-2 border-b border-surface-container-highest pb-4">
          {settingsSections.map((section) => {
            const active =
              section.path === '/settings'
                ? location.pathname === '/settings' || location.pathname === '/settings/'
                : location.pathname.startsWith(section.path);
            return (
              <Link
                key={section.id}
                to={section.path}
                className={`rounded px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? 'bg-secondary/15 text-secondary'
                    : 'text-on-surface-variant hover:bg-surface-container-highest'
                }`}
              >
                {section.label}
              </Link>
            );
          })}
        </nav>

        {children}

        {status && statusVariant !== 'success' ? (
          <StatusMessage message={status} variant={statusVariant} className="mt-6" mono />
        ) : null}
      </div>

      <footer className="fixed bottom-16 left-0 right-0 z-20 flex flex-col gap-3 border-t border-surface-container-highest bg-surface-low/95 px-4 py-3 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 sm:py-4 md:bottom-0 md:ml-60">
        <div className="flex min-w-0 items-center gap-2">
          {statusVariant === 'success' && status ? (
            <>
              <IconCheck className="size-3.5 shrink-0 text-success" />
              <span className="min-w-0 flex-1 code-md text-success line-clamp-2 sm:truncate" title={status}>
                {status}
              </span>
            </>
          ) : status ? (
            <StatusMessage message={status} variant={statusVariant} mono className="min-w-0 truncate" />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 sm:gap-4">
          <Button type="button" variant="ghost" onClick={onDiscard}>
            <span className="sm:hidden">Discard</span>
            <span className="hidden sm:inline">Discard Changes</span>
          </Button>
          <Button type="submit" variant="primary" form={formId} disabled={!configLoaded}>
            <IconLock className="size-3.5" />
            <span className="sm:hidden">Save</span>
            <span className="hidden sm:inline">Save changes</span>
          </Button>
        </div>
      </footer>
    </>
  );
}
