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

export const settingsSections = [
  { id: 'general', label: 'General', path: '/settings' },
  { id: 'models', label: 'Models', path: '/settings/models' },
  { id: 'github', label: 'GitHub', path: '/settings/github' },
  { id: 'opencode', label: 'OpenCode', path: '/settings/opencode' },
  { id: 'ocr', label: 'OCR', path: '/settings/ocr' },
] as const;

export type SettingsSectionId = (typeof settingsSections)[number]['id'];

export function getSettingsSection(path: string): SettingsSectionId {
  const normalized = path.replace(/\/+$/, '') || '/settings';
  const match = settingsSections.find(
    (section) =>
      section.path !== '/settings' &&
      (normalized === section.path || normalized.startsWith(`${section.path}/`)),
  );
  return match?.id ?? 'general';
}
