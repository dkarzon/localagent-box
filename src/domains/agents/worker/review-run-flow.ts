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
  getOcrReviewConcurrency,
  writeOcrConfig,
  runOcrReview,
  runOcrSessionShow,
} from '../../../integrations/open-code-review/runner';
import type { OcrReviewEnvelope } from '../../../integrations/open-code-review/types';
import { extractOcrTokenUsage } from '../../../integrations/open-code-review/token-usage';
import { buildReviewBackground, readParentTranscriptLines } from '../../../lib/review-background';
import {
  isFindingAutoEligible,
  normalizeReviewFindings,
  sortFindingsForAutofix,
  splitFindingsIntoBatches,
} from '../../../lib/review-findings';
import { normalizeRepoAutofixSettings } from '../../repos/repo.repository';
import { appendLog, readAgentRecord, updateAgentRecord } from './agent-state-writer';
import { loadRepoConfig } from './repo-config';
import {
  REVIEW_CHECK_NAME,
  checkOutputForComplete,
  checkOutputForInProgress,
  conclusionForReviewComplete,
} from '../../../lib/review-github-check';
import type {
  AgentJob,
  AgentReviewCheckConclusion,
  AgentReviewMetadata,
  AppConfig,
  ReviewAutofixPlan,
  ReviewFindingRecord,
} from '../../../types';
import type { WorkerContext } from './worker-context';

const execFileAsync = promisify(execFile);

export function resolveReviewRunConfig(config: AppConfig, job: AgentJob): AppConfig {
  if (job.model) {
    return { ...config, reviewModel: job.model };
  }
  return config;
}

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

/** Atomically replaces review-findings.json (temp file + rename). */
function writeFindingsAtomic(findingsPath: string, findings: ReviewFindingRecord[]): void {
  fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
  const tempPath = `${findingsPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(findings, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tempPath, findingsPath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/**
 * Atomically writes review-autofix-plan.json, or removes the file when the
 * plan is null (autofix disabled or no eligible findings).
 */
function writePlanAtomic(planPath: string, plan: ReviewAutofixPlan | null): void {
  if (plan === null) {
    try {
      fs.unlinkSync(planPath);
    } catch {
      // nothing to remove
    }
    return;
  }
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  const tempPath = `${planPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tempPath, planPath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/**
 * Materializes review-autofix-plan.json from the repository's snapshotted
 * autofix settings and the eligible findings (plan Phase 5, task 1–3).
 *
 * Returns null (and removes any stale plan file) when autofix is disabled,
 * repository settings are unavailable, or no finding is auto-eligible.
 */
function materializeAutofixPlan(params: {
  repoId: string;
  repoAutofix: unknown;
  findings: ReviewFindingRecord[];
  reviewedSha: string | null;
  baseBranch: string | null;
  headBranch: string;
  prNumber: number | null;
}): ReviewAutofixPlan | null {
  const settings = normalizeRepoAutofixSettings(params.repoAutofix);
  if (settings.severityThreshold === 'disabled') {
    return null;
  }
  const eligible = sortFindingsForAutofix(
    params.findings.filter((finding) => isFindingAutoEligible(finding, settings.severityThreshold)),
  );
  if (eligible.length === 0) {
    return null;
  }
  const groups = splitFindingsIntoBatches(eligible, settings.maxFindingsPerBatch);
  return {
    schemaVersion: 1,
    snapshot: {
      severityThreshold: settings.severityThreshold,
      maxFindingsPerBatch: settings.maxFindingsPerBatch,
      reviewedSha: params.reviewedSha,
      baseBranch: params.baseBranch || params.headBranch,
      headBranch: params.headBranch,
      prNumber: params.prNumber,
      snapshottedAt: new Date().toISOString(),
    },
    chainStatus: 'running',
    batches: groups.map((group, index) => ({
      index,
      findingIds: group.map((finding) => finding.id),
      agentId: null,
      status: 'pending',
    })),
    nextBatchIndex: 0,
    verification: { status: 'none', agentId: null },
  };
}

/**
 * Looks up the PR for the review's head branch and creates the
 * `localagent-box / review` check run on the PR head SHA, before OCR.
 *
 * Returns the PR number, head SHA, and created check-run id (null when there
 * is no matching PR or creation failed — both are non-fatal).
 */
async function startReviewCheck(
  ctx: WorkerContext,
  headBranch: string,
): Promise<{
  prNumber: number | null;
  headSha: string | null;
  checkRunId: number | null;
}> {
  const { config, githubApp, job, logPath, agentsStore } = ctx;
  const repo = ctx.repo;
  if (!repo) {
    return { prNumber: null, headSha: null, checkRunId: null };
  }

  let prNumber: number | null = null;
  let headSha: string | null = null;
  try {
    appendLog(logPath, `Searching for PR with head branch ${headBranch}`);
    const pr = await githubApp.findPullRequestByHead(config, repo.owner, repo.name, headBranch);
    if (pr && typeof pr.number === 'number') {
      prNumber = pr.number;
      headSha = pr.head?.sha || null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(logPath, `Warning: PR lookup failed — ${message}`);
    return { prNumber: null, headSha: null, checkRunId: null };
  }

  if (!prNumber || !headSha) {
    appendLog(logPath, `No matching open PR with head SHA for branch ${headBranch}, skipping check`);
    return { prNumber, headSha, checkRunId: null };
  }

  try {
    appendLog(logPath, `Creating check run "${REVIEW_CHECK_NAME}" on ${headSha.slice(0, 7)}`);
    const check = await githubApp.createCheckRun(config, repo.owner, repo.name, {
      name: REVIEW_CHECK_NAME,
      headSha,
      status: 'in_progress',
      startedAt: new Date().toISOString(),
      output: checkOutputForInProgress(),
    });
    appendLog(logPath, `Check run created: id=${check.id}`);

    const review: Partial<AgentReviewMetadata> = {
      prNumber,
      headSha,
      githubCheckRunId: check.id,
      githubCheckHeadSha: headSha,
      githubCheckConclusion: null,
    };
    updateAgentRecord(agentsStore, job.agentId, { review: review as AgentReviewMetadata });
    return { prNumber, headSha, checkRunId: check.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(logPath, `Warning: creating check run failed — ${message}`);
    // Still persist prNumber/headSha so comment posting can reuse the lookup.
    updateAgentRecord(agentsStore, job.agentId, {
      review: { prNumber, headSha } as AgentReviewMetadata,
    });
    return { prNumber, headSha, checkRunId: null };
  }
}

/**
 * PATCHes the review's check run to a terminal state. Best-effort: failures
 * are logged warnings and never affect the review's local outcome.
 *
 * `summaryOverride` replaces the default per-conclusion summary text (used by
 * the worker crash path, which wants the actual error message).
 */
export async function completeReviewCheck(
  ctx: WorkerContext,
  checkRunId: number,
  conclusion: AgentReviewCheckConclusion,
  findings: ReviewFindingRecord[],
  summaryMarkdown?: string | null,
  summaryOverride?: string,
): Promise<void> {
  const { config, githubApp, logPath, agentsStore, job } = ctx;
  const repo = ctx.repo;
  if (!repo) {
    return;
  }
  try {
    const output = summaryOverride
      ? checkOutputForComplete({ conclusion, findings: [], summary: summaryOverride })
      : checkOutputForComplete({ conclusion, findings, summaryMarkdown });
    await githubApp.updateCheckRun(config, repo.owner, repo.name, checkRunId, {
      status: 'completed',
      conclusion,
      completedAt: new Date().toISOString(),
      output,
    });
    appendLog(logPath, `Check run ${checkRunId} completed with ${conclusion}`);
    updateAgentRecord(agentsStore, job.agentId, {
      review: { githubCheckConclusion: conclusion } as AgentReviewMetadata,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(logPath, `Warning: updating check run ${checkRunId} failed — ${message}`);
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

  const existingReview = agentRecord?.review;
  let verificationMeta: Pick<
    AgentReviewMetadata,
    'purpose' | 'autofixIneligible' | 'sourceReviewAgentId'
  > = {};
  if (
    existingReview &&
    (existingReview.purpose === 'verification' || existingReview.autofixIneligible === true)
  ) {
    verificationMeta = {
      purpose: 'verification',
      autofixIneligible: true,
      sourceReviewAgentId: existingReview.sourceReviewAgentId || job.agentId,
    };
  }

  const runConfig = resolveReviewRunConfig(config, job);

  // PR lookup + check-run creation happen before OCR so the check appears as
  // soon as the review starts. Both steps are non-fatal.
  const started = await startReviewCheck(ctx, headBranch);
  const foundPrNumber = started.prNumber;
  let headSha = started.headSha;
  const checkRunId = started.checkRunId;

  let ocrResult: OcrReviewEnvelope | null = null;
  let ocrFailed = false;
  let ocrErrorMessage: string | null = null;

  try {
    writeOcrConfig(runConfig, job.workspaceDir);
    appendLog(logPath, 'OCR config written to workspace');
    appendLog(
      logPath,
      `Running OCR review (${job.baseBranch}..${headBranch}) model=${runConfig.reviewModel || runConfig.opencodeModel || 'llama3.2'} fileTimeout=${getOcrFileTimeoutMinutes()}m llmTimeout=${getOcrLlmTimeoutSeconds()}s concurrency=${getOcrReviewConcurrency()}`,
    );
    ocrResult = await runOcrReview({
      config: runConfig,
      workspaceDir: job.workspaceDir,
      baseBranch: job.baseBranch,
      headBranch,
      background: background || undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(logPath, `OCR review failed: ${message}`);
    ocrFailed = true;
    ocrErrorMessage = message;
  }

  if (ocrFailed || !ocrResult) {
    if (checkRunId) {
      await completeReviewCheck(ctx, checkRunId, 'failure', [], null);
    }
    updateAgentRecord(agentsStore, job.agentId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: ocrErrorMessage,
    });
    return;
  }

  const successfulOcrResult: OcrReviewEnvelope = ocrResult;

  let storedPath = '';
  try {
    const agentDir = path.join(job.dataDir, 'agents', job.agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    storedPath = path.join(agentDir, 'review-result.json');
    fs.writeFileSync(storedPath, JSON.stringify(successfulOcrResult, null, 2));
    appendLog(logPath, `OCR result saved to ${storedPath}`);

    if (successfulOcrResult.session_id) {
      try {
        const sessionDetail = await runOcrSessionShow({
          workspaceDir: job.workspaceDir,
          sessionId: successfulOcrResult.session_id,
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

  if (!headSha) {
    headSha = await resolveHeadSha(job.workspaceDir);
  }

  const findingsPath = path.join(job.dataDir, 'agents', job.agentId, 'review-findings.json');
  let findings: ReviewFindingRecord[] = [];
  try {
    findings = normalizeReviewFindings(job.agentId, successfulOcrResult, headSha);
    writeFindingsAtomic(findingsPath, findings);
    appendLog(logPath, `Persisted ${findings.length} structured finding(s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(logPath, `Warning: persisting review findings failed — ${message}`);
  }

  const persistFindings = (reason: string): void => {
    try {
      writeFindingsAtomic(findingsPath, findings);
      appendLog(logPath, `${reason}: review-findings.json updated`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLog(logPath, `Warning: ${reason} — persisting findings failed — ${message}`);
    }
  };

  let githubReviewId: string | null = null;
  let githubWarning: string | null = null;
  const repo = ctx.repo;

  // Complete the check run before posting PR comments; comments can fail
  // without rolling back the check.
  if (checkRunId) {
    const conclusion = conclusionForReviewComplete(findings);
    await completeReviewCheck(
      ctx,
      checkRunId,
      conclusion,
      findings,
      formatReviewSummaryMarkdown(successfulOcrResult),
    );
  }

  try {
    if (foundPrNumber && repo) {
      appendLog(logPath, `Posting review to GitHub for PR #${foundPrNumber}`);
      const { lineComments, fileComments } = partitionReviewComments(successfulOcrResult);
      const reviewBody = formatReviewSummaryMarkdown(successfulOcrResult);

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
      let reviewCommentsListed = false;
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
            body: formatReviewMarkdown(successfulOcrResult),
            event: 'COMMENT',
          },
        );
      }
      githubReviewId = reviewResponse.id ? String(reviewResponse.id) : null;
      appendLog(logPath, `GitHub PR #${foundPrNumber} review posted`);

      // Map line comments created inside the submitted review back onto
      // findings. Submission order is authoritative but each match is
      // validated against path/line; ambiguous mappings stay unlinked.
      if (githubReviewId && lineComments.length > 0 && typeof foundPrNumber === 'number') {
        try {
          const postedComments = await githubApp.listPullRequestReviewComments(
            config,
            repo.owner,
            repo.name,
            foundPrNumber,
            githubReviewId,
          );
          reviewCommentsListed = postedComments.length >= lineComments.length;
          if (reviewCommentsListed) {
            let cursor = 0;
            let mapped = 0;
            for (const lineComment of lineComments) {
              let matched: (typeof postedComments)[number] | null = null;
              while (cursor < postedComments.length) {
                const candidate = postedComments[cursor];
                cursor += 1;
                const startMatch =
                  typeof lineComment.start_line === 'number'
                    ? candidate.start_line === lineComment.start_line
                    : candidate.start_line === null;
                if (
                  candidate.path === lineComment.path &&
                  candidate.line !== null &&
                  candidate.line === lineComment.line &&
                  startMatch
                ) {
                  matched = candidate;
                  break;
                }
              }
              if (!matched) {
                appendLog(
                  logPath,
                  `Warning: could not map a GitHub comment to finding ordinal ${lineComment.ordinal}; leaving it unlinked`,
                );
                continue;
              }
              const record = findings[lineComment.ordinal];
              if (!record) {
                continue;
              }
              record.github.reviewId = githubReviewId;
              record.github.commentId = matched.id;
              record.github.commentUrl = matched.html_url || null;
              record.github.resolutionStatus = 'pending';
              mapped += 1;
            }
            appendLog(logPath, `Mapped ${mapped} line comment(s) onto findings`);
            if (mapped > 0) {
              persistFindings('Comment mapping');
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendLog(logPath, `Warning: listing review comments for mapping failed — ${message}`);
        }
      }

      if (postFileCommentsSeparately && fileComments.length > 0 && headSha) {
        let postedFileComments = 0;
        for (const comment of fileComments) {
          try {
            const created = await githubApp.createPullRequestReviewComment(
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
            const record = findings[comment.ordinal];
            if (record) {
              record.github.reviewId = githubReviewId;
              record.github.commentId = Number(created.id) || null;
              record.github.commentUrl = created.html_url || null;
              record.github.resolutionStatus = 'pending';
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            appendLog(
              logPath,
              `Warning: file comment on ${comment.path} failed — ${message}`,
            );
          }
        }
        appendLog(logPath, `Posted ${postedFileComments} file-level comment(s)`);
        if (postedFileComments > 0) {
          persistFindings('File comment capture');
        }
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

  const tokenUsage = extractOcrTokenUsage(successfulOcrResult);
  if (tokenUsage) {
    appendLog(
      logPath,
      `OCR token usage total: inputTokens=${tokenUsage.inputTokens} outputTokens=${tokenUsage.outputTokens}`,
    );
  }

  // Materialize the autofix plan from the repository's snapshotted settings
  // and eligible findings (plan: required ordering steps 4–5). Never depends
  // on GitHub posting success; batch agents are created server-side when the
  // review-completed event is observed.
  const autofixPlanPath = path.join(job.dataDir, 'agents', job.agentId, 'review-autofix-plan.json');
  try {
    const plan = materializeAutofixPlan({
      repoId: job.repoId,
      repoAutofix: ctx.repo?.autofix,
      findings,
      reviewedSha: headSha,
      baseBranch: job.baseBranch || null,
      headBranch,
      prNumber: foundPrNumber,
    });
    writePlanAtomic(autofixPlanPath, plan);
    if (plan) {
      appendLog(
        logPath,
        `Autofix plan created: ${plan.batches.length} batch(es) from ${findings.length} finding(s)`,
      );
    } else {
      appendLog(logPath, 'Autofix plan not created (disabled or no eligible findings)');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(logPath, `Warning: materializing autofix plan failed — ${message}`);
  }

  const finishedRecord = readAgentRecord(agentsStore, job.agentId);
  const preservedCheckFields: Partial<AgentReviewMetadata> = finishedRecord?.review?.githubCheckConclusion
    ? { githubCheckConclusion: finishedRecord.review.githubCheckConclusion }
    : {};

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
      githubCheckRunId: checkRunId,
      githubCheckHeadSha: checkRunId ? headSha : null,
      ...preservedCheckFields,
      ...verificationMeta,
    },
  });

  appendLog(logPath, 'Review agent completed successfully');
}
