import { Field, Select } from '../../components/ui/Form';
import { modelOptions } from './helpers';

interface ModelCatalogSelectProps {
  label: string;
  value: string;
  catalog: string[];
  placeholder?: string;
  disabled?: boolean;
  unreachableLabel?: string;
  notInCatalogSuffix?: string;
  hint?: string;
  onChange: (value: string) => void;
}

export function ModelCatalogSelect({
  label,
  value,
  catalog,
  placeholder = '',
  disabled = false,
  unreachableLabel = '— host unreachable —',
  notInCatalogSuffix = ' (not in catalog)',
  hint,
  onChange,
}: ModelCatalogSelectProps) {
  const options = modelOptions(catalog, value);

  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {/* Single empty-valued option; surface the empty-catalog state inside it. */}
        {placeholder || !options.length ? (
          <option value="">
            {[placeholder, !options.length ? unreachableLabel : ''].filter(Boolean).join(' ')}
          </option>
        ) : null}
        {!options.length ? null : (
          options.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
              {value === entry && !catalog.includes(entry) ? notInCatalogSuffix : ''}
            </option>
          ))
        )}
      </Select>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </Field>
  );
}
