export const navPages = [
  {
    id: 'agents',
    label: 'Agent Sessions',
    title: 'Agent Sessions',
    subtitle: 'Real-time oversight of autonomous orchestration nodes.',
    path: '/agents',
  },
  {
    id: 'repos',
    label: 'Repositories',
    title: 'Repository Management',
    subtitle: 'Register and manage GitHub repositories for agent orchestration.',
    path: '/repos',
  },
  {
    id: 'settings',
    label: 'Settings',
    title: 'System Configuration',
    subtitle: 'Manage technical orchestration parameters and integration endpoints.',
    path: '/settings',
  },
] as const;

export type NavPage = (typeof navPages)[number]['id'];

export const getPageId = (path: string): NavPage => {
  const page = navPages.find(
    (p) => path === p.path || path.startsWith(`${p.path}/`),
  );
  return page?.id ?? 'agents';
};

export const agentSessionPath = (agentId: string) =>
  `/agents/${encodeURIComponent(agentId)}`;

export const parseAgentSessionId = (path: string): string | null => {
  const match = path.match(/^\/agents\/([^/]+)$/);
  return match?.[1] ?? null;
};

export const PAGE_TITLES = Object.fromEntries(
  navPages.map((p) => [p.id, p.title]),
) as Record<NavPage, string>;

export const PAGE_LABELS = Object.fromEntries(
  navPages.map((p) => [p.id, p.label]),
) as Record<NavPage, string>;

export const PAGE_SUBTITLES = Object.fromEntries(
  navPages.map((p) => [p.id, p.subtitle]),
) as Record<NavPage, string>;
