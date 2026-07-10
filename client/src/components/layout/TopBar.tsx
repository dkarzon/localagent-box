export function TopBar({
  page,
}: { page: NavPage }) {
  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between border-b border-surface-container-highest bg-surface px-6">
      <div className="ml-auto size-8 rounded-full border border-outline-variant bg-primary-container" />
    </header>
  );
}
