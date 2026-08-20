# GitHub App setup

localagent-box authenticates to GitHub as a **GitHub App**, not with a personal access token or SSH key. The app mints short-lived installation tokens server-side (see `src/services/github-app.ts`) to clone repos, push branches, and open pull requests. This guide walks through creating and installing that app.

## 1. Create the GitHub App

1. Go to **GitHub Settings → Developer settings → GitHub Apps → New GitHub App** ([github.com/settings/apps/new](https://github.com/settings/apps/new)), or your organization's equivalent page for an org-owned app.
2. Fill in the required fields:
   - **GitHub App name** — anything unique, e.g. `localagent-box-yourname`.
   - **Homepage URL** — any URL is fine (e.g. your fork's repo URL); it isn't used by localagent-box.
   - **Webhook** — uncheck **Active**. localagent-box does not currently expose an inbound webhook endpoint, so no webhook URL or secret is needed.
3. Under **Permissions → Repository permissions**, grant only what's needed:

   | Permission | Access | Why |
   |------------|--------|-----|
   | Contents | Read and write | Clone, commit, and push agent branches |
   | Pull requests | Read and write | Open PRs and post review comments after agent runs |
   | Metadata | Read-only (mandatory default) | Required by GitHub for any app |

   No other repository or account permissions are required. Avoid granting broader access (Actions, Admin, etc.) than this table.
4. Under **Where can this GitHub App be installed?**, choose **Only on this account** unless you specifically want it installable by other orgs/users.
5. Click **Create GitHub App**.

## 2. Generate a private key

1. On the app's settings page, scroll to **Private keys** and click **Generate a private key**.
2. A `.pem` file downloads automatically. Keep it secret — it is the credential localagent-box uses to mint installation tokens (see [SECURITY.md](../SECURITY.md) for how it's stored).
3. Note the **App ID** shown near the top of the same page; you'll need it below.

## 3. Install the app on your repositories

1. From the app's settings page, click **Install App** in the left sidebar.
2. Choose the account/organization, then select **Only select repositories** and pick the repos you want localagent-box to work with (or **All repositories** if you prefer).
3. After installing, note the **installation ID** — it's the number at the end of the URL when you view the installation, e.g. `https://github.com/settings/installations/12345678` → installation ID `12345678`.

## 4. Configure localagent-box

Open the localagent-box UI and go to **Settings** in the left sidebar, then fill in the **GitHub Integration** card:

| Field | Value |
|-------|-------|
| **App ID** | App ID from step 2 |
| **Installation ID** | Installation ID from step 3 |
| **Private Key (PEM)** | Full contents of the `.pem` file from step 2 |
| **Git User Name** / **Git User Email** | Commit author identity used for agent commits |

Enter your **Bearer Token** in the **API Access** card at the top of the page first (it's required to save settings) — this is the same value as your `API_TOKEN` environment variable. Once the GitHub fields are filled in, click **Commit System Changes** at the bottom of the page to save.

You can paste the private key with either literal newlines or `\n`-escaped newlines — both are accepted. After saving, the field shows a placeholder confirming a key is stored; the raw PEM is never redisplayed. The **GitHub Integration** card's status line (below the header) updates to **GitHub App configured** once all three credentials and a git author are set.

## 5. Register a repository and verify

Go to **Repositories** in the left sidebar and use the **Register Repository** form:

1. Enter **Owner** (the GitHub org or user, e.g. `your-org`) and **Repository Name** (e.g. `your-repo`).
2. Leave **Default Branch** as `main` or change it to match your repo.
3. Click **Register**.

The new repo appears under **Active Inventory**. Click **Verify clone** on its card to confirm access — this performs a real shallow clone using a freshly minted installation token, checking that the app ID, installation ID, and private key are all correct and that the app can actually see the repository. A successful check flips the badge to **Verified**; a failed one shows **Clone Failed** with the error message from GitHub.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `GitHub App credentials are not fully configured` | One of `githubAppId` / `githubAppInstallationId` / `githubAppPrivateKey` is missing from config |
| `GitHub API returned HTTP 401` when verifying | Private key doesn't match the App ID, or the key wasn't saved with real newlines |
| `GitHub API returned HTTP 404` on clone/verify | The app isn't installed on that repository, or the installation ID is wrong |
| Clone succeeds but PR creation fails | The installation doesn't have **Pull requests: Read and write** permission — update permissions on the app, then re-approve the installation |
| Permission changes not taking effect | After changing permissions on the GitHub App, existing installations must accept the new permissions (GitHub sends the org/user owner a notification) before they apply |

See [SECURITY.md](../SECURITY.md) for how the private key is stored and what to do if you suspect it's been compromised (regenerate/revoke the key from the app's settings page immediately).
