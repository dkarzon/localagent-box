interface FilterTabsProps<T extends string> {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}

export function FilterTabs<T extends string>({ tabs, active, onChange }: FilterTabsProps<T>) {
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`rounded border px-3 py-1.5 text-sm transition-colors cursor-pointer ${
            active === tab.id
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-outline-variant bg-surface-container-highest text-on-surface-variant hover:border-primary hover:text-primary'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
