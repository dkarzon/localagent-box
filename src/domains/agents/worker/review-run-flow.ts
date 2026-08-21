import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import {
  formatReviewMarkdown,
  formatReviewSummaryMarkdown,
  partitionReviewComments,
} from '../../../integrations/open-code-review/format-review';
import {
  getOcrFileTimeoutMinutes,
  getOcrLlmTimeoutSeconds,
  writeOcrConfig,
  runOcrReview,
  runOcrSessionShow,
} from '../../../integrations/open-code-review/runner';
import type { OcrReviewEnvelope } from '../../../integrations/open-code-review/types';
import { extractOcrTokenUsage } from '../../../integrations/open-code-review/token-usage';
import { buildReviewBackground, readParentTranscriptLines } from '../../../lib/review-background';
import { appendLog, readAgentRecord, updateAgentRecord } from './agent-state-writer';
import { loadRepoConfig } from './repo-config';
import type { WorkerContext } from './worker-context';

const execFileAsync = promisify(execFile);

async function resolveHeadSha(workspaceDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceDir });
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

function loadParentTranscript(dataDir: string, parentAgentId: string): string {
  const conversationPath = path.join(dataDir, 'agents', parentAgentId, 'conversation.jsonl');
  if (!fs.existsSync(conversationPath)) {
    return '';
  }
  try {
    const lines = fs.readFileSync(conversationPath, 'utf8').trim().split('\n');
    return readParentTranscriptLines(lines);
  } catch {
    return '';
  }
}

export async function runReviewJob(ctx: WorkerContext): Promise<void> {
  const { job, logPath, config, agentsStore, githubApp } = ctx;

  appendLog(logPath, 'Starting review agent workflow');

  const headBranch = job.headBranch || job.agentBranch;
  if (!headBranch) {
    throw new Error('Review mode requires a head branch');
  }

  appendLog(logPath, `Base: ${job.baseBranch}, Head: ${headBranch}`);

  const agentRecord = readAgentRecord(agentsStore, job.agentId);
  const repoPromptOverrides = loadRepoConfig(job.workspaceDir);
  const parentAgent =
    agentRecord?.parentAgentId && !agentRecord.review?.background
      ? readAgentRecord(agentsStore, agentRecord.parentAgentId)
      : null;
  const parentContext = parentAgent
    ? loadParentTranscript(job.dataDir, parentAgent.agentId)
    : null;

  const background = buildReviewBackground(
    agentRecord || {
      agentId: job.agentId,
      workspaceId: job.workspaceId,
      repoId: job.repoId,
      mode: 'review',
      prompt: job.prompt || '',
      systemPrompt: job.systemPrompt || null,
      baseBranch: job.baseBranch,
      agentBranch: job.agentBranch,
      commitMessage: job.commitMessage,
      push: job.push,
      pushOnFailure: job.pushOnFailure,
      model: job.model || null,
      status: 'running',
      commitSha: null,
      pushed: false,
      filesChanged: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      branch: null,
      error: null,
      result: null,
      review: {
        baseBranch: job.baseBranch,
        headBranch,
        background: job.background || null,
      },
      parentAgentId: null,
    },
    repoPromptOverrides,
    parentContext,
    parentAgent?.prompt,
  );

  let ocrResult: OcrReviewEnvelope;

  try {
    writeOcrConfig(config, job.workspaceDir);
    appendLog(logPath, 'OCR config written to workspace');
    appendLog(
      logPath,
      `Running OCR review (${job.baseBranch}..${headBranch}) fileTimeout=${getOcrFileTimeoutMinutes()}m llmTimeout=${getOcrLlmTimeoutSeconds()}s`,
    );
    ocrResult = await runOcrReview({
      config,
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

  let storedPath = '';
  try {
    const agentDir = path.join(job.dataDir, 'agents', job.agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    storedPath = path.join(agentDir, 'review-result.json');
    fs.writeFileSync(storedPath, JSON.stringify(ocrResult, null, 2));
    appendLog(logPath, `OCR result saved to ${storedPath}`);

    if (ocrResult.session_id) {
      try {
        const sessionDetail = await runOcrSessionShow({
          workspaceDir: job.workspaceDir,
          sessionId: ocrResult.session_id,
        });
        const sessionPath = path.join(agentDir, 'review-session.json');
        fs.writeFileSync(sessionPath, JSON.stringify(sessionDetail ?? {}, null, 2));
        appendLog(logPath, `OCR session saved to ${sessionPath}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendLog(logPath, `Warning: OCR session show failed — ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(logPath, `Warning: saving OCR result failed — ${message}`);
  }

  let foundPrNumber: number | null = null;
  let headSha: string | null = null;
  const repo = ctx.repo;
  if (repo) {
    try {
      appendLog(logPath, `Searching for PR with head branch ${headBranch}`);
      const pr = await githubApp.findPullRequestByHead(config, repo.owner, repo.name, headBranch);
      if (pr && typeof pr.number === 'number') {
        foundPrNumber = pr.number;
        headSha = pr.head?.sha || null;
      }
    } catch {
      // non-fatal
    }
  }

  if (!headSha) {
    headSha = await resolveHeadSha(job.workspaceDir);
  }

  let githubReviewId: string | null = null;
  let githubWarning: string | null = null;

  try {
    if (foundPrNumber && repo) {
      appendLog(logPath, `Posting review to GitHub for PR #${foundPrNumber}`);
      const { lineComments, fileComments } = partitionReviewComments(ocrResult);
      const reviewBody = formatReviewSummaryMarkdown(ocrResult);

      if (lineComments.length > 0) {
        appendLog(
          logPath,
          `Posting ${lineComments.length} line comment(s) and ${fileComments.length} file comment(s)`,
        );
      } else if (fileComments.length > 0) {
        appendLog(logPath, `Posting ${fileComments.length} file comment(s)`);
      }

      const lineCommentPayload = lineComments.map((comment) => ({
        path: comment.path,
        body: comment.body,
        line: comment.line,
        ...(comment.side ? { side: comment.side } : {}),
        ...(typeof comment.start_line === 'number' ? { start_line: comment.start_line } : {}),
        ...(comment.start_side ? { start_side: comment.start_side } : {}),
      }));

      let reviewResponse: { id: string; html_url: string };
      let postFileCommentsSeparately = true;
      try {
        reviewResponse = await githubApp.createPullRequestReview(
          config,
          repo.owner,
          repo.name,
          foundPrNumber,
          {
            body: reviewBody,
            event: 'COMMENT',
            comments: lineCommentPayload,
          },
        );
      } catch (lineCommentErr) {
        if (lineComments.length === 0) {
          throw lineCommentErr;
        }
        const lineCommentMessage =
          lineCommentErr instanceof Error ? lineCommentErr.message : String(lineCommentErr);
        appendLog(
          logPath,
          `Warning: line comments failed — ${lineCommentMessage}, retrying with summary-only review`,
        );
        postFileCommentsSeparately = false;
        reviewResponse = await githubApp.createPullRequestReview(
          config,
          repo.owner,
          repo.name,
          foundPrNumber,
          {
            body: formatReviewMarkdown(ocrResult),
            event: 'COMMENT',
          },
        );
      }
      githubReviewId = reviewResponse.id ? String(reviewResponse.id) : null;
      appendLog(logPath, `GitHub PR #${foundPrNumber} review posted`);

      if (postFileCommentsSeparately && fileComments.length > 0 && headSha) {
        let postedFileComments = 0;
        for (const comment of fileComments) {
          try {
            await githubApp.createPullRequestReviewComment(
              config,
              repo.owner,
              repo.name,
              foundPrNumber,
              {
                commit_id: headSha,
                path: comment.path,
                body: comment.body,
                subject_type: 'file',
              },
            );
            postedFileComments += 1;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            appendLog(
              logPath,
              `Warning: file comment on ${comment.path} failed — ${message}`,
            );
          }
        }
        appendLog(logPath, `Posted ${postedFileComments} file-level comment(s)`);
      } else if (postFileCommentsSeparately && fileComments.length > 0 && !headSha) {
        appendLog(
          logPath,
          `Warning: ${fileComments.length} file comment(s) skipped — head SHA unavailable`,
        );
      }
    } else {
      appendLog(logPath, `No matching PR found for branch ${headBranch}, skipping GitHub post`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    githubWarning = `GitHub review post failed: ${message}`;
    appendLog(logPath, `Warning: ${githubWarning}`);
  }

  const tokenUsage = extractOcrTokenUsage(ocrResult);
  if (tokenUsage) {
    appendLog(
      logPath,
      `OCR token usage total: inputTokens=${tokenUsage.inputTokens} outputTokens=${tokenUsage.outputTokens}`,
    );
  }

  updateAgentRecord(agentsStore, job.agentId, {
    status: 'completed',
    finishedAt: new Date().toISOString(),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(githubWarning
      ? {
          result: {
            branch: headBranch,
            baseBranch: job.baseBranch,
            workspaceId: job.workspaceId,
            commitSha: headSha,
            pushed: false,
            filesChanged: 0,
            warning: githubWarning,
            opencodeSuccess: true,
          },
        }
      : {}),
    review: {
      baseBranch: job.baseBranch || null,
      headBranch: headBranch || null,
      background: background || null,
      ocrResultPath: storedPath || undefined,
      prNumber: foundPrNumber ?? null,
      headSha: headSha ?? null,
      githubReviewId,
    },
  });

  appendLog(logPath, 'Review agent completed successfully');
}
