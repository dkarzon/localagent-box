## Code Review

⚠️ **Review partially complete** — Review partially complete: 36 finding(s); 3 of 26 selected item(s) failed.

26 files reviewed · 21m31s

### Branch range

`main` → `ollama-cloud`

Commit range: `3369a6827763cbb237ce391a6a9adddc0986db44..98a070faee15b00f20f537cca2dc62464ee5b4a3`

### Coverage

| | Count |
| --- | ---: |
| Selected | 26 |
| Completed | 23 |
| Failed | 3 |

### Run stats

| Metric | Value |
| --- | --- |
| Files reviewed | 26 |
| Findings | 36 |
| Elapsed | 21m31s |
| Tokens | 3,770,223 (3,324,061 in / 446,162 out) |

### Severity & categories

| Severity | Count |
| --- | ---: |
| 🟡 medium | 10 |
| 🔵 low | 26 |

| Category | Count |
| --- | ---: |
| 🔧 Maintainability | 16 |
| 🐛 Bug | 14 |
| Other | 2 |
| 🔒 Security | 2 |
| ⚡ Performance | 1 |
| 🎨 Style | 1 |

### Findings

#### `client/src/pages/AgentSessionsPage.tsx:373-380`

🟡 **medium** · 🐛 Bug
Review-mode start is now gated on `hostReady` (provider reachable AND non-empty model catalog). The server's /health always returns an entry for every provider id (src/routes/health.ts maps all LLM_PROVIDER_IDS), so this gate only bites when the provider is genuinely unreachable or reachable with an empty catalog — in which case Start is permanently disabled. That contradicts the copy directly below the review-model select ("Uses Settings default when {providerLabel} is unavailable") and the option label "— {providerLabel} unreachable (uses Settings default) —" (which renders exactly when availableModels is empty, i.e. when the button is disabled, making the option unusable). It also removes the previous ability to queue a review that would run with the configured reviewModel/opencodeModel fallback. Consider gating review mode on reachability only (not the model catalog), or relaxing when a Settings default review model exists, and aligning the hint text.

**Suggestion:**
```suggestion
const providerReachable = consumerStatus?.reachable === true;

  const startDisabled =
    !repos.length ||
    !configLoaded ||
    (mode === 'review'
      ? !reviewHeadBranch.trim() || !providerReachable
      : !hostReady || (mode === 'loop' ? !loopCanStart : !model.trim()));
```

#### `client/src/pages/SettingsPage.tsx:235-238`

🟡 **medium** · 🐛 Bug
Search is now scoped to the active section: each section hides cards whose labels don't match `searchQuery`, so a query that previously surfaced cards anywhere in Settings (e.g. 'github' while on General) now renders an empty page with no 'no results' feedback — a regression of the existing global settings search. This is compounded by the search box not being cleared when switching section tabs (App only resets `searchQuery` when the top-level page changes, so a stale query follows the user across tabs). Suggest rendering an empty-state message when a query filters out every card in the section, or keeping search matching across all sections.

**Referenced code:**
```
{section === 'general' ? (
          <GeneralSettingsSection
            token={token}
            setToken={setToken}
```

#### `client/src/pages/SettingsPage.tsx:84`

🟡 **medium** · 🐛 Bug
`next.opencodeProvider` is trusted to be a valid `LlmProviderId`, but configs saved before this change may hold legacy free-text values: the backend `toPublicConfig` returns `config.opencodeProvider || 'ollama'` without enum validation, and the PUT handler now rejects anything but 'ollama'/'ollama-cloud' with VALIDATION_ERROR. With a legacy value stored, this select renders with no matching option (blank display) and saving the OpenCode tab fails until the user manually re-picks a provider. Normalize here (and ideally in the backend's toPublicConfig/loadRaw so the client type stays truthful).

**Suggestion:**
```suggestion
setOpencodeProvider(
      next.opencodeProvider && LLM_PROVIDER_IDS.includes(next.opencodeProvider)
        ? next.opencodeProvider
        : 'ollama',
    );
```

#### `client/src/pages/settings/OpenCodeSettingsSection.tsx:115-121`

🟡 **medium** · 🐛 Bug
The "Default model" select renders no empty-valued option when `placeholder` is unset and the catalog is non-empty: with an empty saved `opencodeModel` (the default state), `<Select value="">` matches no option and displays blank (selectedIndex -1), and once any model is picked the user can no longer clear it back to "use fallback". The server only applies its `llama3.2` fallback when the field is empty (`config.opencodeModel || 'llama3.2'` in src/services/opencode-config.ts), so the previous free-text input's clear-to-fallback behavior is lost. Pass a placeholder (like the loop-verb and review-model selects do) to provide the empty option.

**Suggestion:**
```suggestion
<ModelCatalogSelect
              label="Default model"
              value={opencodeModel}
              catalog={availableModels}
              placeholder="Default (llama3.2 fallback)"
              unreachableLabel={unreachableLabel}
              onChange={setOpencodeModel}
            />
```

#### `src/server.ts:47-49`

🟡 **medium** · 🐛 Bug
env.opencodeProvider is blindly cast to LlmProviderId and persisted without validation, while the API path (src/routes/config.ts PUT) enforces isLlmProviderId via assertValidProvider. A typo'd env value (e.g. OLLAMA_CLOUD or 'claude') is silently written to the config store. resolveOpenCodeProvider then falls back to 'ollama' for such values, so the opencode config is generated with the wrong provider (or not written at all if ollamaBaseUrl is empty), breaking reviews until the value is manually fixed via the API. Validate before persisting.

**Suggestion:**
```suggestion
partial.opencodeProvider = isLlmProviderId(env.opencodeProvider)
      ? env.opencodeProvider
      : current.opencodeProvider;
```

#### `src/server.ts:54-56`

🟡 **medium** · 🐛 Bug
env.ollamaCloudBaseUrl is persisted without any URL validation, whereas the equivalent API field is validated with assertValidHttpUrl in src/routes/config.ts. An invalid env value (e.g. missing protocol) flows into resolveProviderHost → normalizeOpenCodeBaseUrl and is written as an unusable baseURL into opencode.json. Consider reusing the http(s) URL validation (extract it to a shared lib) and skipping/log-rejecting invalid env values, mirroring the API contract.

**Referenced code:**
```
if (env.ollamaCloudBaseUrl && !current.ollamaCloudBaseUrl) {
    partial.ollamaCloudBaseUrl = env.ollamaCloudBaseUrl;
  }
```

#### `src/services/config-store.ts:104`

🟡 **medium** · 🐛 Bug
opencodeProvider changed from free-form string to the 'ollama'|'ollama-cloud' union, but configs persisted before this change may still hold arbitrary legacy values. loadConfig merges DEFAULT_CONFIG (filling missing keys), yet toPublicConfig only coerces empty with '||' — a legacy non-enum value flows through as-is into PublicConfig typed as LlmProviderId (a type lie), and the client select will match neither option. resolveOpenCodeProvider already guards this at runtime; apply the same coercion here for consistency.

**Suggestion:**
```suggestion
opencodeProvider: isLlmProviderId(config.opencodeProvider)
        ? config.opencodeProvider
        : 'ollama',
```

#### `src/routes/config.ts:104-106`

🟡 **medium** · 🔒 Security
When the resolved provider is 'ollama-cloud', buildOpenCodeConfig now embeds the plaintext Ollama Cloud API key (via resolveProviderHost → buildProviderEntry) and writeOpenCodeConfig persists it to ~/.config/opencode/opencode.json using fs.writeFileSync with default permissions (typically 0644) — unlike the masked '***' exposed by toPublicConfig. This silently widens the exposure surface for the credential. Consider writing the opencode config with a restrictive mode (e.g. 0o600) or confirming this file is treated as secret-bearing.

**Referenced code:**
```
if (isProviderConfigured(finalConfig, resolveOpenCodeProvider(finalConfig))) {
    opencode = ctx.opencodeConfig.writeOpenCodeConfig(finalConfig);
  }
```

#### `src/lib/llm-provider.ts:44-50`

🟡 **medium** · 🐛 Bug
resolveProviderHost dereferences config.ollamaBaseUrl.trim() and config.ollamaCloudApiKey.trim() without null checks, while its sibling isProviderConfigured defensively uses optional chaining (config.ollamaBaseUrl?.trim()). Although AppConfig declares these as plain strings and config-store's loadRaw() spreads persisted JSON over DEFAULT_CONFIG, a hand-edited config.json containing explicit null (or any AppConfig built outside loadConfig) makes these fields undefined at runtime, and any caller that skips the isProviderConfigured guard — e.g. buildOpenCodeConfig → buildProviderEntry in src/services/opencode-config.ts, which is exported and called without a guard at its own layer — will throw a TypeError instead of degrading gracefully. Use optional chaining for consistency and safety.

**Suggestion:**
```suggestion
case 'ollama':
      return { baseUrl: config.ollamaBaseUrl?.trim() ?? '' };
    case 'ollama-cloud':
      return {
        baseUrl: config.ollamaCloudBaseUrl?.trim() || DEFAULT_OLLAMA_CLOUD_BASE_URL,
        apiKey: config.ollamaCloudApiKey?.trim(),
      };
```

#### `src/server.ts:51-53`

🟡 **medium** · 🐛 Bug
bootstrapConfig now seeds ollamaCloudApiKey/ollamaCloudBaseUrl from env, making cloud-only installs a supported scenario (writeOpenCodeConfig self-guards via isProviderConfigured and has a test for 'succeeds for cloud-only installs'). However, the startup write in createContext (line 102) still gates on `if (config.ollamaBaseUrl)` — unchanged from before — unlike the API path in src/routes/config.ts which uses isProviderConfigured(finalConfig, resolveOpenCodeProvider(finalConfig)). For a cloud-only deployment (OLLAMA_CLOUD_API_KEY set, no OLLAMA_BASE_URL) with opencodeProvider 'ollama-cloud', opencode.json is never regenerated at server startup: in containers where /data/config.json is persistent but ~/.config/opencode/ is ephemeral, the OpenCode config stays missing after every restart until Settings is re-saved. Suggest replacing the gate at line 102 with the same provider-aware check, or dropping the outer condition entirely since writeOpenCodeConfig already returns null when the resolved provider is not configured.

**Suggestion:**
```suggestion
// Startup OpenCode write must key on the resolved OpenCode provider, not the
  // local URL: writeOpenCodeConfig no-ops itself when the provider is unconfigured.
  if (isProviderConfigured(config, resolveOpenCodeProvider(config))) {
    opencodeConfig.writeOpenCodeConfig(config);
  }
```

#### `client/src/pages/AgentSessionsPage.tsx:232-235`

🔵 **low** · 🔧 Maintainability
The `?? health?.ollama` fallback substitutes the local Ollama status regardless of provider id: if a `providers` entry for 'ollama-cloud' were ever missing, the UI would show "Ollama Cloud online" with local model lists while the run targets the cloud provider (hostReady could pass on the wrong provider's data). Since the backend always populates both provider entries (unconfigured ones as reachable: false), this fallback is effectively unreachable today — and misleading if it ever fires. Prefer returning null so a missing entry surfaces as offline/unavailable instead of silently borrowing the wrong provider's status.

**Suggestion:**
```suggestion
const consumerStatus = useMemo(
    () => health?.providers?.[consumerProvider] ?? null,
    [health, consumerProvider],
  );
```

#### `client/src/pages/AgentSessionsPage.tsx:237`

🔵 **low** · 🔧 Maintainability
Duplicates provider labeling that already exists as LLM_PROVIDER_LABELS in client/src/api/types.ts (used by settings/ProviderSelect), and the text already drifts: the shared constant says 'Ollama (local)' while this renders 'Ollama'. Reuse the shared constant so labels stay consistent; adjust the constant's text if the shorter form is preferred for the status pill.

**Suggestion:**
```suggestion
const providerLabel = LLM_PROVIDER_LABELS[consumerProvider];
```

#### `client/src/pages/AgentSessionsPage.tsx:192`

🔵 **low** · 🐛 Bug
The narrowed type `opencodeProvider?: LlmProviderId` is trusted blindly, but the backend's toPublicConfig passes persisted values through without validating them against LLM_PROVIDER_IDS (loadRaw spreads the stored JSON as-is), so configs saved before this change can still carry legacy/free-form provider strings. For such a value this page's provider lookup misses and falls back to health?.ollama — which happens to match the server's own normalization of unknown ids to 'ollama', but the unvalidated id still leaks into provider-keyed state and labels elsewhere (e.g. the settings ProviderSelect renders LLM_PROVIDER_LABELS[id], which is undefined for unknown ids). Normalize on load so an unknown id cannot enter provider-keyed state.

**Suggestion:**
```suggestion
setOpencodeProvider(
        config.opencodeProvider &&
          (LLM_PROVIDER_IDS as readonly string[]).includes(config.opencodeProvider)
          ? config.opencodeProvider
          : 'ollama',
      );
```

#### `client/src/pages/AgentSessionsPage.tsx:544`

🔵 **low** · Other
This changes the previous "unknown → online" semantics (`ollama?.reachable !== false`) to "unknown → offline": during initial load (health === null) and whenever the /health fetch fails, the pill flips to "{providerLabel} offline" with a red dot even if the backend is actually healthy. If the stricter semantics are intended this is fine, but consider a distinct loading/unknown state (neutral dot and label such as "checking…") so a slow or failed health check doesn't read as an outage.

**Referenced code:**
```
const systemOnline = consumerStatus?.reachable === true;
```

#### `client/src/api/types.ts:407-414`

🔵 **low** · 🔧 Maintainability
OCR_CONFIG_FIELDS is defined but is the only section group not merged into CONFIG_FIELDS, so reviewProvider/reviewModel are excluded from the ConfigField union while every other group (MODELS, OPENCODE, GITHUB, GENERAL) is included. Note that nothing in the client currently consumes CONFIG_FIELDS/ConfigField (SettingsPage builds each section's PUT payload via a hardcoded switch), so the impact is a latent type-level inconsistency rather than a runtime bug — either merge the OCR group in for completeness, or drop the unused field-group constants if they are not going to drive the forms.

**Suggestion:**
```suggestion
export const CONFIG_FIELDS = [
  ...MODELS_CONFIG_FIELDS,
  ...OPENCODE_CONFIG_FIELDS,
  ...OCR_CONFIG_FIELDS,
  ...GITHUB_CONFIG_FIELDS,
  ...GENERAL_CONFIG_FIELDS,
] as const;
```

#### `client/src/navigation.ts:74-76`

🔵 **low** · 🔧 Maintainability
settingsSectionPath has no consumers anywhere in the client: SettingsPage uses getSettingsSection and SettingsLayout iterates settingsSections directly. If it isn't needed for upcoming routing work, drop it to avoid unused exported surface; otherwise wire it in where section paths are resolved.

**Referenced code:**
```
export function settingsSectionPath(id: SettingsSectionId): string {
  return settingsSections.find((section) => section.id === id)?.path ?? '/settings';
}
```

#### `client/src/pages/settings/ProviderSelect.tsx:27`

🔵 **low** · 🐛 Bug
Before `/api/v1/config` resolves, `config` is `{}` so `isProviderConfigured` is false for every provider — all options, including the default 'ollama', briefly render as '(not configured)' and are disabled, mislabeling providers that may actually be configured and making the select unchangeable until load completes. Consider passing `configLoaded` down (or treating 'ollama' as enabled by default) so the pre-load state isn't shown as 'not configured'.

**Referenced code:**
```
<option key={id} value={id} disabled={!configured}>
```

#### `client/src/pages/SettingsPage.tsx:223-224`

🔵 **low** · 🔧 Maintainability
`refreshLocalHealth` and `refreshCloudHealth` are identical wrappers around `loadHealth()`, so both refresh buttons refetch the entire health payload (the server re-probes local Ollama and Ollama Cloud together). Either pass `loadHealth` directly to both buttons, or implement a targeted per-provider probe if independent refresh was the intent.

**Suggestion:**
```suggestion
onRefreshLocal={loadHealth}
            onRefreshCloud={loadHealth}
```

#### `client/src/pages/settings/ModelCatalogSelect.tsx:32-35`

🔵 **low** · 🐛 Bug
When the catalog is empty and a `placeholder` is set (e.g. the loop-verb selects use 'Default (use global model)'), two `<option value="">` entries render: the placeholder is displayed and `unreachableLabel` ('— Ollama unreachable —' / '— no models available —') becomes a second blank-valued option that is never the visible selection, hiding the empty-catalog state from the user. Render the unreachable option only when there is no placeholder, and let callers surface the empty-catalog message via `hint` instead.

**Suggestion:**
```suggestion
{placeholder ? <option value="">{placeholder}</option> : null}
        {!options.length && !placeholder ? (
          <option value="">{unreachableLabel}</option>
        ) : (
```

#### `client/src/pages/settings/helpers.ts:25-28`

🔵 **low** · 🔧 Maintainability
The `showSection` closure (query normalization + label matching) is re-declared with identical logic in all five section components under `client/src/pages/settings/`, while `fieldMatchesSearch` was already extracted into this shared helpers module. Extract a `makeShowSection(searchQuery)` factory here too so the per-tab filtering behavior cannot drift between sections.

**Suggestion:**
```suggestion
export function makeShowSection(searchQuery: string) {
  const query = searchQuery.trim().toLowerCase();
  return (labels: string[]) =>
    !query || labels.some((label) => label.toLowerCase().includes(query));
}
```

#### `client/src/pages/AgentSessionsPage.tsx:907-913`

🔵 **low** · 🐛 Bug
The copy still advertises the "uses Settings default" fallback, but startDisabled now requires hostReady (provider reachable AND non-empty catalog) in review mode, so this placeholder only ever renders while Start review is disabled — the promised fallback path is unreachable. The hint below the select ("Uses Settings default when {providerLabel} is unavailable.") has the same contradiction: previously review mode could start without a model and the server would apply its default (runConfig.reviewModel || runConfig.opencodeModel), but now the gate blocks the submit entirely whenever the provider is down or its /api/tags catalog is empty. Update the placeholder/hint to tell the user how to recover (e.g., point at the Models settings) or relax the gate for review mode when a server-side default exists.

**Suggestion:**
```suggestion
{!availableModels.length ? (
                      <option value="">
                        {consumerStatus?.reachable === false
                          ? `— ${providerLabel} unreachable — configure it in Settings —`
                          : `— no ${providerLabel} models available —`}
                      </option>
                    ) : (
```

#### `client/src/pages/settings/OpenCodeSettingsSection.tsx:67-74`

🔵 **low** · 🔧 Maintainability
This provider-catalog derivation (sorted model list + `unreachableLabel` with a hardcoded provider-name ternary) is duplicated verbatim in OcrSettingsSection, and the ternary duplicates the existing `LLM_PROVIDER_LABELS` map. Extract a helper (e.g. `describeModelCatalog(providerStatus, providerId)`) into ./helpers.ts and reuse `LLM_PROVIDER_LABELS[providerId]` for the label. OcrSettingsSection additionally computes `effectiveProvider` but then re-inlines the same `reviewProvider || config.opencodeProvider || 'ollama'` expression for `ProviderSelect` instead of reusing it.

**Suggestion:**
```suggestion
// helpers.ts
  export function describeModelCatalog(
    status: OllamaStatus | null | undefined,
    providerId: LlmProviderId,
  ): { catalog: string[]; unreachableLabel: string } {
    const catalog = [...(status?.models ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((model) => model.name);
    const unreachableLabel =
      status?.reachable === false
        ? `— ${LLM_PROVIDER_LABELS[providerId]} unreachable —`
        : '— no models available —';
    return { catalog, unreachableLabel };
  }
```

#### `client/src/pages/SettingsPage.tsx:215-216`

🔵 **low** · ⚡ Performance
`loadHealth()` and `loadGithubStatus()` are independent refreshes; awaiting them sequentially serializes two network round-trips after every save. Run them concurrently with `Promise.all`.

**Suggestion:**
```suggestion
await Promise.all([loadHealth(), loadGithubStatus()]);
```

#### `src/routes/config.ts:38-40`

🔵 **low** · 🔧 Maintainability
The allowed-provider list is hardcoded in the error message instead of derived from LLM_PROVIDER_IDS; when a provider is added, this message will silently drift. Import LLM_PROVIDER_IDS (re-exported from ../lib/llm-provider) and build the message from it.

**Suggestion:**
```suggestion
if (!isLlmProviderId(value)) {
    throw new CodedError(
      `${field} must be one of: ${LLM_PROVIDER_IDS.join(', ')}`,
      'VALIDATION_ERROR',
    );
  }
```

#### `src/routes/health.ts:23-29`

🔵 **low** · 🔧 Maintainability
The not-configured message ternary is duplicated within this function (also computed in the branch above) and again in src/routes/config.ts and src/server.ts — a drift risk as providers are added. Extract a shared helper (e.g. providerNotConfiguredMessage(id) in lib/llm-provider.ts) and reuse it in all three call sites.

**Referenced code:**
```
const host = resolveProviderHost(config, id);
  return ctx.ollamaProbe.probe({
    baseUrl: host.baseUrl,
    apiKey: host.apiKey,
    notConfiguredMessage:
      id === 'ollama' ? 'ollamaBaseUrl is not set' : 'ollamaCloudApiKey is not set',
  });
```

_…and 11 more finding(s)._


### Files that could not be reviewed

- `src/domains/agents/worker/review-run-flow.ts` — unknown: stopped because context compression exceeded its threshold
- `src/integrations/open-code-review/runner.ts` — unknown: stopped because context compression exceeded its threshold
- `src/services/opencode-config.ts` — unknown: stopped because context compression exceeded its threshold

### Tool usage

Total tool calls: 227
code_search (105) · file_read (92) · file_read_diff (13) · code_comment (12) · file_find (5)

<details>
<summary>Files reviewed successfully</summary>

- `client/src/pages/settings/GithubSettingsSection.tsx`
- `src/lib/llm-provider.ts`
- `client/src/api/types.ts`
- `client/src/pages/settings/GeneralSettingsSection.tsx`
- `client/src/pages/AgentSessionsPage.tsx`
- `src/routes/config.ts`
- `src/server.ts`
- `client/src/pages/settings/ModelsSettingsSection.tsx`
- `client/src/pages/settings/OpenCodeSettingsSection.tsx`
- `src/types/index.ts`
- `client/src/pages/settings/helpers.ts`
- `src/lib/pr-content-generator.ts`
- `client/src/pages/SettingsPage.tsx`
- `client/src/pages/settings/SettingsLayout.tsx`
- `src/services/ollama-client.ts`
- `src/services/config-store.ts`
- `src/config/env.ts`
- `client/src/pages/settings/OcrSettingsSection.tsx`
- `client/src/navigation.ts`
- `client/src/pages/settings/ModelCatalogSelect.tsx`
- `src/routes/health.ts`
- `src/services/ollama-probe.ts`
- `client/src/pages/settings/ProviderSelect.tsx`

</details>

<sub>localagent-box · OCR v1.11.2 · glm-5.3-flash:cloud · session 8b251309</sub>