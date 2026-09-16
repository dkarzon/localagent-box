import type { AppConfig, HealthResponse, LlmProviderId } from '../../api/types';
import { SectionCard } from '../../components/ui/Card';
import { CheckboxField } from '../../components/ui/Form';
import { ModelCatalogSelect } from './ModelCatalogSelect';
import { ProviderSelect } from './ProviderSelect';

interface OcrSettingsSectionProps {
  config: AppConfig;
  health: HealthResponse | null;
  reviewProvider: LlmProviderId | '';
  setReviewProvider: (value: LlmProviderId) => void;
  reviewModel: string;
  setReviewModel: (value: string) => void;
  autoReviewPullRequests: boolean;
  setAutoReviewPullRequests: (value: boolean) => void;
  searchQuery: string;
}

export function OcrSettingsSection({
  config,
  health,
  reviewProvider,
  setReviewProvider,
  reviewModel,
  setReviewModel,
  autoReviewPullRequests,
  setAutoReviewPullRequests,
  searchQuery,
}: OcrSettingsSectionProps) {
  const query = searchQuery.trim().toLowerCase();
  const showSection = (labels: string[]) =>
    !query || labels.some((label) => label.toLowerCase().includes(query));

  const effectiveProvider = reviewProvider || config.opencodeProvider || 'ollama';
  const providerStatus = health?.providers?.[effectiveProvider] ?? null;
  const availableModels = [...(providerStatus?.models ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((model) => model.name);
  const unreachableLabel =
    providerStatus?.reachable === false
      ? `— ${effectiveProvider === 'ollama-cloud' ? 'Ollama Cloud' : 'Ollama'} unreachable —`
      : '— no models available —';

  if (!showSection(['review', 'ocr', 'code review', 'auto-review'])) {
    return null;
  }

  return (
    <SectionCard title="Code review (OCR)" icon={<span className="code-md text-secondary">CR</span>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <ProviderSelect
          label="Review provider"
          value={reviewProvider || config.opencodeProvider || 'ollama'}
          config={config}
          onChange={setReviewProvider}
        />
        <ModelCatalogSelect
          label="Review model"
          value={reviewModel}
          catalog={availableModels}
          placeholder="Leave empty to use OpenCode model"
          unreachableLabel={unreachableLabel}
          onChange={setReviewModel}
        />
      </div>
      <div className="mt-4">
        <CheckboxField
          label="Auto-review pull requests after agent-created PRs"
          checked={autoReviewPullRequests}
          onChange={(e) => setAutoReviewPullRequests(e.target.checked)}
        />
        <p className="mt-2 text-sm text-muted">
          When enabled, a review agent is queued automatically after a coding agent creates a pull
          request. Per-repo settings can override this default.
        </p>
      </div>
    </SectionCard>
  );
}
