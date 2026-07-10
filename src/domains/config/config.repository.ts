import type { AppConfig, ConfigPartial, PublicConfig } from '../../types';
import { createConfigStore, type ConfigStore } from '../../services/config-store';

export interface ConfigRepository {
  load: () => AppConfig;
  save: (partial: ConfigPartial) => AppConfig;
  toPublic: (config: AppConfig) => PublicConfig;
}

export function createConfigRepository(dataDir: string, fs: Parameters<typeof createConfigStore>[1]): ConfigRepository {
  const store: ConfigStore = createConfigStore(dataDir, fs);
  return {
    load: () => store.loadConfig(),
    save: (partial) => store.saveConfig(partial),
    toPublic: (config) => store.toPublicConfig(config),
  };
}

export type AppConfigFields = keyof AppConfig;
export type PublicConfigFields = keyof PublicConfig;
export type AgentConfigFields = 'autoApprovePermissions';
