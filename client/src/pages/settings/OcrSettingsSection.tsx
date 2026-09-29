import type { AppConfig, HealthResponse, LlmProviderId } from '../../api/types';
import { SectionCard } from '../../components/ui/Card';
import { CheckboxField } from '../../components/ui/Form';
import { ModelCatalogSelect } from './ModelCatalogSelect';
import { ProviderSelect } from './ProviderSelect';
import { SETTINGS_SEARCH_KEYWORDS, describeModelCatalog, makeShowSection } from './helpers';

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
  const showSection = makeShowSection(searchQuery);

  const effectiveProvider = reviewProvider || config.opencodeProvider || 'ollama';
  const { catalog: availableModels, unreachableLabel } = describeModelCatalog(
    health?.providers?.[effectiveProvider],
    effectiveProvider,
  );

  if (!showSection(SETTINGS_SEARCH_KEYWORDS.ocr.review)) {
    return null;
  }

  return (
    <SectionCard title="Code review (OCR)" icon={<span className="code-md text-secondary">CR</span>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <ProviderSelect
          label="Review provider"
          value={effectiveProvider}
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
