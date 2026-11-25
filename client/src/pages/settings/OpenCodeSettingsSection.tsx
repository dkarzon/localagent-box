import { type AppConfig, type HealthResponse, type LlmProviderId } from '../../api/types';
import { SectionCard } from '../../components/ui/Card';
import { CheckboxField, Field, TextArea } from '../../components/ui/Form';
import { ModelCatalogSelect } from './ModelCatalogSelect';
import { ProviderSelect } from './ProviderSelect';
import { SETTINGS_SEARCH_KEYWORDS, describeModelCatalog, makeShowSection } from './helpers';

interface OpenCodeSettingsSectionProps {
  config: AppConfig;
  health: HealthResponse | null;
  opencodeProvider: LlmProviderId;
  setOpencodeProvider: (value: LlmProviderId) => void;
  opencodeModel: string;
  setOpencodeModel: (value: string) => void;
  systemPrompt: string;
  setSystemPrompt: (value: string) => void;
  batchAutoApprovePermissions: boolean;
  setBatchAutoApprovePermissions: (value: boolean) => void;
  searchQuery: string;
}

export function OpenCodeSettingsSection({
  config,
  health,
  opencodeProvider,
  setOpencodeProvider,
  opencodeModel,
  setOpencodeModel,
  systemPrompt,
  setSystemPrompt,
  batchAutoApprovePermissions,
  setBatchAutoApprovePermissions,
  searchQuery,
}: OpenCodeSettingsSectionProps) {
  const showSection = makeShowSection(searchQuery);
  const keywords = SETTINGS_SEARCH_KEYWORDS.opencode;

  const { catalog: availableModels, unreachableLabel } = describeModelCatalog(
    health?.providers?.[opencodeProvider],
    opencodeProvider,
  );

  return (
    <div className="grid gap-6">
      {showSection(keywords.defaults) ? (
        <SectionCard title="OpenCode defaults" icon={<span className="code-md text-secondary">OC</span>}>
          <div className="grid gap-4 sm:grid-cols-2">
            <ProviderSelect
              label="Provider"
              value={opencodeProvider}
              config={config}
              onChange={setOpencodeProvider}
            />
            <ModelCatalogSelect
              label="Default model"
              value={opencodeModel}
              catalog={availableModels}
              placeholder="Default (llama3.2)"
              unreachableLabel={unreachableLabel}
              onChange={setOpencodeModel}
            />
          </div>
          <Field label="Default System Prompt" className="mt-4">
            <TextArea
              name="systemPrompt"
              rows={3}
              placeholder="Optional default system prompt prepended for every agent"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </Field>
        </SectionCard>
      ) : null}

      {showSection(keywords.permissions) ? (
        <SectionCard
          title="OpenCode permissions"
          icon={<span className="code-md text-secondary">OC</span>}
        >
          <CheckboxField
            label="Batch — auto-approve tool permissions"
            checked={batchAutoApprovePermissions}
            onChange={(e) => setBatchAutoApprovePermissions(e.target.checked)}
          />
        </SectionCard>
      ) : null}
    </div>
  );
}
