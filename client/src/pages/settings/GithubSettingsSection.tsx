import { IconGithub } from '../../components/icons';
import { SectionCard } from '../../components/ui/Card';
import { Field, TextArea, TextInput } from '../../components/ui/Form';
import { StatusMessage } from '../../components/ui/StatusMessage';

interface GithubSettingsSectionProps {
  githubStatus: string;
  githubAppId: string;
  setGithubAppId: (value: string) => void;
  githubAppInstallationId: string;
  setGithubAppInstallationId: (value: string) => void;
  githubAppPrivateKey: string;
  setGithubAppPrivateKey: (value: string) => void;
  hasExistingKey: boolean;
  gitUserName: string;
  setGitUserName: (value: string) => void;
  gitUserEmail: string;
  setGitUserEmail: (value: string) => void;
  searchQuery: string;
}

export function GithubSettingsSection({
  githubStatus,
  githubAppId,
  setGithubAppId,
  githubAppInstallationId,
  setGithubAppInstallationId,
  githubAppPrivateKey,
  setGithubAppPrivateKey,
  hasExistingKey,
  gitUserName,
  setGitUserName,
  gitUserEmail,
  setGitUserEmail,
  searchQuery,
}: GithubSettingsSectionProps) {
  const query = searchQuery.trim().toLowerCase();
  const showSection = (labels: string[]) =>
    !query || labels.some((label) => label.toLowerCase().includes(query));

  if (!showSection(['github', 'git', 'app', 'private key'])) {
    return null;
  }

  return (
    <SectionCard title="GitHub Integration" icon={<IconGithub className="size-4" />}>
      <StatusMessage message={githubStatus} variant="" className="mb-4" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="App ID">
          <TextInput
            name="githubAppId"
            value={githubAppId}
            onChange={(e) => setGithubAppId(e.target.value)}
          />
        </Field>
        <Field label="Installation ID">
          <TextInput
            name="githubAppInstallationId"
            value={githubAppInstallationId}
            onChange={(e) => setGithubAppInstallationId(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Private Key (PEM)" className="mt-4">
        <TextArea
          name="githubAppPrivateKey"
          rows={4}
          placeholder={
            hasExistingKey
              ? 'Existing key stored — paste new PEM to replace'
              : 'Paste GitHub App private key PEM'
          }
          value={githubAppPrivateKey === '***' ? '' : githubAppPrivateKey}
          onChange={(e) => setGithubAppPrivateKey(e.target.value)}
        />
      </Field>
      <p className="mt-2 text-sm text-muted">
        Paste your PEM private key generated in GitHub App settings.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Git User Name">
          <TextInput
            name="gitUserName"
            value={gitUserName}
            onChange={(e) => setGitUserName(e.target.value)}
          />
        </Field>
        <Field label="Git User Email">
          <TextInput
            name="gitUserEmail"
            type="text"
            inputMode="email"
            value={gitUserEmail}
            onChange={(e) => setGitUserEmail(e.target.value)}
          />
        </Field>
      </div>
      <p className="mt-2 text-sm text-muted">
        Leave blank to auto-fill from your GitHub App&apos;s <code className="code-md">[bot]</code>{' '}
        identity when you save.
      </p>
    </SectionCard>
  );
}
