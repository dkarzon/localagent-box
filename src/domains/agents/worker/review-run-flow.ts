import fs from 'fs';
import path from 'path';
import { writeOcrConfig, runOcrReview } from '../../../integrations/open-code-review/runner';
import { appendLog, updateAgentRecord } from './agent-state-writer';
import type { WorkerContext } from './worker-context';

function buildReviewMarkdown(result: { summary?: string; issues?: Array<{ file?: string; line?: number; message: string }> }): string {
  const summary = result.summary || 'Code review completed.';
  let body = `## Code Review Summary\n\n${summary}`;

  if (result.issues && result.issues.length > 0) {
    body += '\n\n---\n\n### Issues Found';
    for (const issue of result.issues.slice(0, 20)) {
      const loc = issue.file ? `${issue.file}${typeof issue.line === 'number' ? `:L${issue.line}` : ''}` : '';
      body += `\n- **${loc}** ${issue.message}`;
    }
  }

  return body.trim();
}

export async function runReviewJob(ctx: WorkerContext): Promise<void> {
  const { job, logPath, config, agentsStore, githubApp } = ctx;

  appendLog(logPath, 'Starting review agent workflow');

  // headBranch comes directly from the Agent record on review mode agents
  const headBranch = (job as any).headBranch || job.agentBranch;

  if (!headBranch) {
    throw new Error('Review mode requires a head branch');
  }

  appendLog(logPath, `Base: ${job.baseBranch}, Head: ${headBranch}`);

  // Step 1: Write OCR configuration
  writeOcrConfig(config, job.workspaceDir);
  appendLog(logPath, 'OCR config written to workspace');

  // Step 2: Run the OCR review
  const background = (job as any).background;
  let ocrResult: { summary?: string; issues?: Array<{ file?: string; line?: number; message: string }> };

  try {
    appendLog(logPath, `Running OCR review (${job.baseBranch}..${headBranch})`);
    ocrResult = await runOcrReview({
      workspaceDir: job.workspaceDir,
      baseBranch: job.baseBranch,
      headBranch,
      background: background || undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(logPath, `OCR review failed: ${message}`);

    updateAgentRecord(agentsStore, job.agentId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: message,
    });
    return;
  }

  // Step 3: Store raw OCR result on disk
  let storedPath = '';
  try {
    const agentDir = path.join(job.dataDir, 'agents', job.agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    storedPath = path.join(agentDir, 'review-result.json');
    fs.writeFileSync(storedPath, JSON.stringify(ocrResult, null, 2));
    appendLog(logPath, `OCR result saved to ${storedPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(logPath, `Warning: saving OCR result failed — ${message}`);
  }

  // Step 4: Find matching PR on GitHub via head branch
  let foundPrNumber: number | null = null;
  const repo = ctx.repo;
  if (repo) {
    try {
      appendLog(logPath, `Searching for PR with head branch ${headBranch}`);
      const pr = await githubApp.findPullRequestByHead(config, repo.owner, repo.name, headBranch);
      if (pr && typeof (pr as any).number === 'number') {
        foundPrNumber = (pr as any).number;
      }
    } catch {}
  }

  // Step 5: Post review comment to GitHub PR if found
  try {
    if (foundPrNumber) {
      appendLog(logPath, `Posting review to GitHub for PR #${foundPrNumber}`);
      const reviewBody = buildReviewMarkdown(ocrResult);
      await githubApp.createPullRequestReview(config, repo.owner, repo.name, foundPrNumber, {
        body: reviewBody,
        event: 'COMMENT',
      });
      appendLog(logPath, `GitHub PR #${foundPrNumber} review posted`);
    } else {
      appendLog(logPath, `No matching PR found for branch ${headBranch}, skipping GitHub post`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(logPath, `Warning: GitHub post failed (${message})`);
  }

  // Step 6: Mark agent completed — no commit/push for reviews
  updateAgentRecord(agentsStore, job.agentId, {
    status: 'completed',
    finishedAt: new Date().toISOString(),
    review: {
      baseBranch: job.baseBranch || null,
      headBranch: headBranch || null,
      background: background ? String(background) : null,
      ocrResultPath: storedPath || undefined,
      prNumber: foundPrNumber ?? null,
    },
  });

  appendLog(logPath, 'Review agent completed successfully');
}