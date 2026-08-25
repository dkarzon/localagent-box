import fs from 'fs';
import path from 'path';

/**
 * App-wide runtime profile: a toolchain the host can bootstrap a workspace with.
 * Shipped in `config/runtime-profiles.json` and resolved per-repo in Phase 2.
 */
export interface RuntimeProfile {
  /** Workspace-root files whose presence (any match) suggests this profile applies. */
  detect: string[];
  /** Setup command run in the workspace when this profile is resolved. */
  defaultSetup: string;
  /** Runtime binaries this profile provides (informational for docs and the status API). */
  tools: string[];
  /** User cache dirs the dependency cache layer (Phase 3) may reuse across runs. */
  cacheDirs: string[];
}

export interface RuntimeProfilesCatalog {
  profiles: Record<string, RuntimeProfile>;
}

const runtimeProfilesPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'config',
  'runtime-profiles.json',
);

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as unknown;
}

function assertObject(raw: unknown, location: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${location} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function validateStringList(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array of strings`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${location}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

export function validateRuntimeProfilesCatalog(raw: unknown): RuntimeProfilesCatalog {
  const catalog = assertObject(raw, 'runtime-profiles.json');
  const profilesRaw = catalog.profiles;
  if (typeof profilesRaw !== 'object' || profilesRaw === null || Array.isArray(profilesRaw)) {
    throw new Error('runtime-profiles.json profiles must be a JSON object');
  }

  const profiles: Record<string, RuntimeProfile> = {};
  for (const [name, entry] of Object.entries(profilesRaw)) {
    const profile = assertObject(entry, `runtime-profiles.json profiles.${name}`);

    const defaultSetup = profile.defaultSetup;
    if (typeof defaultSetup !== 'string' || defaultSetup.trim() === '') {
      throw new Error(`runtime-profiles.json profiles.${name} defaultSetup must be a non-empty string`);
    }

    profiles[name] = {
      detect: validateStringList(profile.detect, `runtime-profiles.json profiles.${name} detect`),
      defaultSetup,
      tools: validateStringList(profile.tools, `runtime-profiles.json profiles.${name} tools`),
      cacheDirs: validateStringList(profile.cacheDirs, `runtime-profiles.json profiles.${name} cacheDirs`),
    };
  }

  return { profiles };
}

export function loadRuntimeProfiles(
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs,
): Record<string, RuntimeProfile> {
  if (!fsImpl.existsSync(runtimeProfilesPath)) {
    throw new Error(`Bundled runtime profile catalog not found at ${runtimeProfilesPath}`);
  }
  const catalog = validateRuntimeProfilesCatalog(readJsonFile(runtimeProfilesPath));
  return catalog.profiles;
}

export function getRuntimeProfile(
  name: string,
  profiles: Record<string, RuntimeProfile> = loadRuntimeProfiles(),
): RuntimeProfile | undefined {
  return profiles[name];
}
