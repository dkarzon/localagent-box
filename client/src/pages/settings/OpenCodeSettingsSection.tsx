import {
  LOOP_VERB_LABELS,
  LOOP_VERBS,
  type AppConfig,
  type HealthResponse,
  type LoopVerb,
  type LoopVerbModels,
  type LlmProviderId,
} from '../../api/types';
import { SectionCard } from '../../components/ui/Card';
import { Button, CheckboxField, Field, TextArea, TextInput } from '../../components/ui/Form';
import { ModelCatalogSelect } from './ModelCatalogSelect';
import { ProviderSelect } from './ProviderSelect';
import {
  SETTINGS_SEARCH_KEYWORDS,
  describeModelCatalog,
  fieldMatchesSearch,
  makeShowSection,
} from './helpers';

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
  loopAutoApprovePermissions: boolean;
  setLoopAutoApprovePermissions: (value: boolean) => void;
  interactiveAutoApprovePermissions: boolean;
  setInteractiveAutoApprovePermissions: (value: boolean) => void;
  interactiveAgentTimeoutSeconds: number;
  setInteractiveAgentTimeoutSeconds: (value: number) => void;
  loopAgentTimeoutSeconds: number;
  setLoopAgentTimeoutSeconds: (value: number) => void;
  loopVerbModels: LoopVerbModels;
  setLoopVerbModels: React.Dispatch<React.SetStateAction<LoopVerbModels>>;
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
  loopAutoApprovePermissions,
  setLoopAutoApprovePermissions,
  interactiveAutoApprovePermissions,
  setInteractiveAutoApprovePermissions,
  interactiveAgentTimeoutSeconds,
  setInteractiveAgentTimeoutSeconds,
  loopAgentTimeoutSeconds,
  setLoopAgentTimeoutSeconds,
  loopVerbModels,
  setLoopVerbModels,
  searchQuery,
}: OpenCodeSettingsSectionProps) {
  const query = searchQuery.trim().toLowerCase();
  const showSection = makeShowSection(searchQuery);
  const keywords = SETTINGS_SEARCH_KEYWORDS.opencode;

  const { catalog: availableModels, unreachableLabel } = describeModelCatalog(
    health?.providers?.[opencodeProvider],
    opencodeProvider,
  );

  const copyGlobalModelToAllLoopVerbs = () => {
    const globalModel = opencodeModel.trim();
    if (!globalModel) return;
    setLoopVerbModels({
      INITIAL_PLAN: globalModel,
      ORIENT: globalModel,
      ACT: globalModel,
      REFLECT: globalModel,
    });
  };

  const applyOrientReflectPreset = () => {
    const source =
      loopVerbModels.ORIENT?.trim() ||
      loopVerbModels.REFLECT?.trim() ||
      opencodeModel.trim();
    if (!source) return;
    setLoopVerbModels((prev) => ({
      ...prev,
      ORIENT: source,
      REFLECT: source,
    }));
  };

  const updateLoopVerbModel = (verb: LoopVerb, model: string) => {
    setLoopVerbModels((prev) => ({ ...prev, [verb]: model }));
  };

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
          title="OpenCode permissions & timeouts"
          icon={<span className="code-md text-secondary">OC</span>}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:gap-8">
            <CheckboxField
              label="Batch — auto-approve tool permissions"
              checked={batchAutoApprovePermissions}
              onChange={(e) => setBatchAutoApprovePermissions(e.target.checked)}
            />
            <CheckboxField
              label="Loop — auto-approve tool permissions"
              checked={loopAutoApprovePermissions}
              onChange={(e) => setLoopAutoApprovePermissions(e.target.checked)}
            />
            <CheckboxField
              label="Interactive — auto-approve tool permissions"
              checked={interactiveAutoApprovePermissions}
              onChange={(e) => setInteractiveAutoApprovePermissions(e.target.checked)}
            />
          </div>
          <hr className="my-4 border-surface-container-highest" />
          <Field label="Interactive Agent Timeout (seconds)">
            <TextInput
              type="number"
              name="interactiveAgentTimeoutSeconds"
              min={60}
              max={86400}
              value={interactiveAgentTimeoutSeconds}
              onChange={(e) => setInteractiveAgentTimeoutSeconds(Number(e.target.value))}
            />
          </Field>
          <Field label="Loop Agent Timeout (seconds)" className="mt-4">
            <TextInput
              type="number"
              name="loopAgentTimeoutSeconds"
              min={60}
              max={86400}
              value={loopAgentTimeoutSeconds}
              onChange={(e) => setLoopAgentTimeoutSeconds(Number(e.target.value))}
            />
          </Field>
        </SectionCard>
      ) : null}

      {showSection(keywords.loop) ? (
        <SectionCard title="Loop mode — models per step" icon={<span className="code-md text-secondary">LP</span>}>
          <p className="text-sm text-muted">
            Leave blank to use the global OpenCode model. Loop verbs share the OpenCode provider
            selected above.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={copyGlobalModelToAllLoopVerbs}
              disabled={!opencodeModel.trim()}
            >
              Copy global model to all verbs
            </Button>
            <Button type="button" variant="ghost" onClick={applyOrientReflectPreset}>
              Same model for Orient / Reflect
            </Button>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {LOOP_VERBS.map((verb) => {
              const { label, hint } = LOOP_VERB_LABELS[verb];
              const selectedModel = loopVerbModels[verb] ?? '';
              if (
                query &&
                !fieldMatchesSearch(label, selectedModel, query) &&
                !fieldMatchesSearch(hint, verb, query)
              ) {
                return null;
              }
              return (
                <ModelCatalogSelect
                  key={verb}
                  label={label}
                  value={selectedModel}
                  catalog={availableModels}
                  placeholder="Default (use global model)"
                  unreachableLabel={unreachableLabel}
                  notInCatalogSuffix=" (not in catalog)"
                  hint={hint}
                  onChange={(value) => updateLoopVerbModel(verb, value)}
                />
              );
            })}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
