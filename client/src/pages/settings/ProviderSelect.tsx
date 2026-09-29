import { Link } from 'react-router-dom';
import {
  LLM_PROVIDER_IDS,
  LLM_PROVIDER_LABELS,
  type AppConfig,
  type LlmProviderId,
} from '../../api/types';
import { Field, Select } from '../../components/ui/Form';
import { isProviderConfigured } from './helpers';

interface ProviderSelectProps {
  label: string;
  value: LlmProviderId | '';
  config: AppConfig;
  onChange: (value: LlmProviderId) => void;
}

export function ProviderSelect({ label, value, config, onChange }: ProviderSelectProps) {
  const selected = value || config.opencodeProvider || 'ollama';

  return (
    <Field label={label}>
      <Select value={selected} onChange={(e) => onChange(e.target.value as LlmProviderId)}>
        {LLM_PROVIDER_IDS.map((id) => {
          const configured = isProviderConfigured(config, id);
          return (
            <option key={id} value={id} disabled={!configured}>
              {LLM_PROVIDER_LABELS[id]}
              {!configured ? ' (not configured)' : ''}
            </option>
          );
        })}
      </Select>
      {LLM_PROVIDER_IDS.some((id) => !isProviderConfigured(config, id)) ? (
        <p className="mt-1 text-xs text-muted">
          Configure connection credentials on{' '}
          <Link to="/settings/models" className="text-secondary hover:underline">
            Models
          </Link>
          .
        </p>
      ) : null}
    </Field>
  );
}
