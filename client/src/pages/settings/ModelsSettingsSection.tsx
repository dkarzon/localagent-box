import { useMemo } from 'react';
import type { AppConfig, OllamaStatus } from '../../api/types';
import { IconRefresh } from '../../components/icons';
import { SectionCard } from '../../components/ui/Card';
import { Button, Field, TextInput } from '../../components/ui/Form';
import { formatFileSize, formatModelUpdated } from '../../lib/format';
import { StatusMessage } from '../../components/ui/StatusMessage';
import {
  SETTINGS_SEARCH_KEYWORDS,
  describeProviderStatus,
  fieldMatchesSearch,
  makeShowSection,
} from './helpers';

interface ModelsSettingsSectionProps {
  config: AppConfig;
  ollamaLocal: OllamaStatus | null;
  ollamaCloud: OllamaStatus | null;
  ollamaBaseUrl: string;
  setOllamaBaseUrl: (value: string) => void;
  ollamaCloudApiKey: string;
  setOllamaCloudApiKey: (value: string) => void;
  ollamaCloudBaseUrl: string;
  setOllamaCloudBaseUrl: (value: string) => void;
  showCloudKey: boolean;
  setShowCloudKey: React.Dispatch<React.SetStateAction<boolean>>;
  onRefreshLocal: () => void;
  onRefreshCloud: () => void;
  searchQuery: string;
}

function ModelList({
  models,
  query,
}: {
  models: OllamaStatus['models'];
  query: string;
}) {
  const filtered = useMemo(() => {
    const list = [...(models ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    if (!query) return list;
    return list.filter((model) => fieldMatchesSearch(model.name, model.name, query));
  }, [models, query]);

  if (!filtered.length) {
    return <p className="code-md text-muted">No models reported.</p>;
  }

  return (
    <div className="divide-y divide-surface-low rounded border border-outline-variant">
      {filtered.map((model) => (
        <div
          key={model.name}
          className="flex items-start justify-between gap-4 px-4 py-2.5 code-md"
        >
          <span className="text-on-surface-variant">{model.name}</span>
          <div className="shrink-0 text-right text-muted">
            {model.size != null ? (
              <p className="text-on-surface-variant">{formatFileSize(model.size)}</p>
            ) : null}
            {model.modifiedAt ? (
              <p className="mt-0.5">{formatModelUpdated(model.modifiedAt)}</p>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ModelsSettingsSection({
  config,
  ollamaLocal,
  ollamaCloud,
  ollamaBaseUrl,
  setOllamaBaseUrl,
  ollamaCloudApiKey,
  setOllamaCloudApiKey,
  ollamaCloudBaseUrl,
  setOllamaCloudBaseUrl,
  showCloudKey,
  setShowCloudKey,
  onRefreshLocal,
  onRefreshCloud,
  searchQuery,
}: ModelsSettingsSectionProps) {
  const query = searchQuery.trim().toLowerCase();
  const showSection = makeShowSection(searchQuery);

  const localInfo = describeProviderStatus(ollamaLocal, 'Ollama');
  const cloudInfo = describeProviderStatus(ollamaCloud, 'Ollama Cloud');

  const cloudKeyPlaceholder = config.hasOllamaCloudApiKey
    ? 'Stored — paste to replace'
    : 'Ollama Cloud API key';

  return (
    <div className="grid gap-6">
      {showSection(SETTINGS_SEARCH_KEYWORDS.models.local) ? (
        <SectionCard
          title="Ollama (local)"
          icon={<span className="size-2 rounded-full bg-success" />}
          action={
            localInfo.connected ? (
              <span className="flex items-center gap-1.5 text-xs text-success">
                <span className="size-1.5 rounded-full bg-success" />
                {localInfo.message}
              </span>
            ) : (
              <StatusMessage message={localInfo.message} variant={localInfo.variant} mono />
            )
          }
        >
          <div className="mb-4 flex flex-col gap-3 sm:flex-row">
            <div className="flex-1">
              <TextInput
                type="url"
                name="ollamaBaseUrl"
                placeholder="http://192.168.1.50:11434"
                value={ollamaBaseUrl}
                onChange={(e) => setOllamaBaseUrl(e.target.value)}
                className="mb-2 sm:mb-0"
              />
              <Button type="button" variant="ghost" onClick={onRefreshLocal} className="w-full">
                <IconRefresh className="size-4" />
                Refresh local status
              </Button>
            </div>
          </div>
          <ModelList models={ollamaLocal?.models} query={query} />
        </SectionCard>
      ) : null}

      {showSection(SETTINGS_SEARCH_KEYWORDS.models.cloud) ? (
        <SectionCard
          title="Ollama Cloud"
          icon={<span className="size-2 rounded-full bg-secondary" />}
          action={
            cloudInfo.connected ? (
              <span className="flex items-center gap-1.5 text-xs text-success">
                <span className="size-1.5 rounded-full bg-success" />
                {cloudInfo.message}
              </span>
            ) : (
              <StatusMessage message={cloudInfo.message} variant={cloudInfo.variant} mono />
            )
          }
        >
          <Field label="API key">
            <div className="relative">
              <TextInput
                type={showCloudKey ? 'text' : 'password'}
                name="ollamaCloudApiKey"
                placeholder={cloudKeyPlaceholder}
                autoComplete="off"
                value={ollamaCloudApiKey === '***' ? '' : ollamaCloudApiKey}
                onChange={(e) => setOllamaCloudApiKey(e.target.value)}
                className="pr-14"
              />
              <button
                type="button"
                onClick={() => setShowCloudKey((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-on-surface cursor-pointer"
              >
                {showCloudKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </Field>
          <Field label="Base URL (optional)" className="mt-4">
            <TextInput
              type="url"
              name="ollamaCloudBaseUrl"
              placeholder="https://ollama.com"
              value={ollamaCloudBaseUrl}
              onChange={(e) => setOllamaCloudBaseUrl(e.target.value)}
            />
          </Field>
          <div className="mt-4">
            <Button type="button" variant="ghost" onClick={onRefreshCloud} className="w-full sm:w-auto">
              <IconRefresh className="size-4" />
              Refresh cloud status
            </Button>
          </div>
          <div className="mt-4">
            <ModelList models={ollamaCloud?.models} query={query} />
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
