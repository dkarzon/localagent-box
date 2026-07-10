import { getServerEnv } from '../config/env';
import { DEFAULT_API_TOKEN } from './auth-constants';

export { DEFAULT_API_TOKEN } from './auth-constants';

export function getApiToken(): string {
  return getServerEnv().apiToken;
}

export function isDefaultApiToken(): boolean {
  return getServerEnv().apiToken === DEFAULT_API_TOKEN;
}
