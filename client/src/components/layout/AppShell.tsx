import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { NavPage } from '../../navigation';
import { navPages } from '../../navigation';
import { IconAgents, IconPlus, IconRepo, IconSettings } from '../icons';
import { Sidebar } from './Sidebar';

interface AppShellProps {
  page: NavPage;
  children: ReactNode;
  footer?: ReactNode;
  onNewOrchestration?: () => void;
}

const mobileNavIcons: Record<NavPage, ReactNode> = {
  agents: <IconAgents className="size-5" />,
  repos: <IconRepo className="size-5" />,
  settings: <IconSettings className="size-5" />,
};

const MOBILE_LABELS: Record<NavPage, string> = {
  agents: 'Agents',
  repos: 'Repos',
  settings: 'Settings',
};

export function AppShell({
  page,
  children,
  footer,
  onNewOrchestration,
}: AppShellProps) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar active={page} onNewOrchestration={onNewOrchestration} />
      <div className="flex min-h-screen flex-col pb-16 md:ml-60 md:pb-0">
        <main className="relative min-w-0 flex-1 overflow-x-hidden">{children}</main>
        {footer}
      </div>
      <nav
        aria-label="Main navigation"
        className="fixed bottom-0 left-0 right-0 z-30 flex justify-around border-t border-surface-container-highest bg-surface-low px-3 py-2 md:hidden"
      >
        {navPages.slice(0, 2).map((navPage) => {
          const isActive = page === navPage.id;
          return (
            <Link
              key={navPage.id}
              to={navPage.path}
              aria-current={isActive ? 'page' : undefined}
              className={`flex flex-col items-center gap-1 rounded p-2 text-sm transition-colors ${
                isActive
                  ? 'text-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {mobileNavIcons[navPage.id]}
              <span className="text-[10px]">{MOBILE_LABELS[navPage.id]}</span>
            </Link>
          );
        })}
        {onNewOrchestration ? (
          <button
            type="button"
            onClick={onNewOrchestration}
            className="flex flex-col items-center gap-1 rounded p-2 text-sm text-primary"
          >
            <IconPlus className="size-5" />
            <span className="text-[10px]">New</span>
          </button>
        ) : null}
        {navPages.slice(2).map((navPage) => {
          const isActive = page === navPage.id;
          return (
            <Link
              key={navPage.id}
              to={navPage.path}
              aria-current={isActive ? 'page' : undefined}
              className={`flex flex-col items-center gap-1 rounded p-2 text-sm transition-colors ${
                isActive
                  ? 'text-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {mobileNavIcons[navPage.id]}
              <span className="text-[10px]">{MOBILE_LABELS[navPage.id]}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
