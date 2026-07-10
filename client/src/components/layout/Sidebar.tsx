import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { IconAgents, IconPlus, IconRepo, IconSettings } from '../icons';
import type { NavPage } from '../../navigation';
import { navPages, PAGE_LABELS } from '../../navigation';

interface SidebarProps {
  active: NavPage;
  onNewOrchestration?: () => void;
}

const navIcons: Record<NavPage, ReactNode> = {
  agents: <IconAgents className="size-5" />,
  repos: <IconRepo className="size-5" />,
  settings: <IconSettings className="size-5" />,
};

export function Sidebar({ active, onNewOrchestration }: SidebarProps) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-surface-container-highest bg-surface-low md:flex">
      <div className="pl-2 py-10">
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded bg-primary">
            <IconAgents className="size-4 text-on-primary" />
          </div>
          <div>
            <p className="text-2xl font-normal leading-tight text-primary">LocalAgentBox</p>
            <p className="label-md text-on-surface-variant">v0.1.0</p>
          </div>
        </div>
      </div>

      <nav aria-label="Main navigation" className="flex flex-1 flex-col gap-2">
        {navPages.map((page) => {
          const isActive = active === page.id;
          return (
            <Link
              key={page.id}
              to={page.path}
              aria-current={isActive ? 'page' : undefined}
              className={`relative flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-base transition-colors ${
                isActive
                  ? 'bg-primary-container text-on-primary-container'
                  : 'text-on-surface-variant hover:bg-surface-container'
              }`}
            >
              <span className={isActive ? 'text-on-primary-container' : 'text-on-surface-variant'}>
                {navIcons[page.id]}
              </span>
              <span className="flex-1">{PAGE_LABELS[page.id]}</span>
            </Link>
          );
        })}
      </nav>

      {onNewOrchestration ? (
        <div className="p-2 pb-6">
          <button
            type="button"
            onClick={onNewOrchestration}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-base text-on-primary transition-colors hover:bg-primary/90 cursor-pointer"
          >
            <IconPlus className="size-4" />
            New Agent
          </button>
        </div>
      ) : null}
    </aside>
  );
}
