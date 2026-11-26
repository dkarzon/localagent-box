import type {
  AgentCheckRun,
  AgentEscalation,
  AgentEscalationAttempt,
  AgentVerification,
} from '../../../types';

/** Escalation fields go to a webhook consumer, so they are kept short (v1 1.5). */
export const ESCALATION_MAX_FIELD_CHARS = 4000;

/** Statuses an escalation is written for: both mean a person has to act. */
export type EscalationStatus = 'needs_attention' | 'failed_machine';

/** Truncates to the recorded length and marks the cut with an ellipsis. */
export function truncateForRecord(text: string, max = ESCALATION_MAX_FIELD_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

/** Attempt 0 is the task turn, so the number of repairs equals the attempt index. */
export function repairAttemptsUsed(verification: AgentVerification): number {
  const lastAttempt = verification.attempts.at(-1);
  return lastAttempt ? lastAttempt.attempt : 0;
}

/**
 * One line for a person: which check is still failing and how many turns the host
 * spent on it, or what stopped a run before a repair turn was possible.
 */
export function escalationSummary(verification: AgentVerification, status: EscalationStatus): string {
  const lastAttempt = verification.attempts.at(-1);
  const failingCheck = lastAttempt?.checks.at(-1);
  if (!lastAttempt || !failingCheck) {
    return status === 'failed_machine' ? 'Machine failure' : 'Checks still failing';
  }

  if (status === 'failed_machine') {
    return `Machine failure (${lastAttempt.machineReason ?? 'unknown'}) during ${failingCheck.name}`;
  }

  const repairs = repairAttemptsUsed(verification);
  return repairs > 0
    ? `${failingCheck.name} still failing after ${repairs} repair attempt(s)`
    : `${failingCheck.name} failing with no repair attempts allowed`;
}

/**
 * Builds the escalation for a run the host could not verify. Returns null when
 * there is nothing to escalate (no attempt, or no failing check in the last one),
 * so the caller can store it only when it is real.
 */
export function buildEscalation(
  verification: AgentVerification,
  status: EscalationStatus,
): AgentEscalation | null {
  const lastAttempt = verification.attempts.at(-1);
  const failingCheck: AgentCheckRun | undefined = lastAttempt?.checks.at(-1);
  if (!failingCheck) {
    return null;
  }

  const attempts: AgentEscalationAttempt[] = verification.attempts.map((attempt) => {
    const stoppedAt = attempt.checks.at(-1);
    return {
      attempt: attempt.attempt,
      diffStat: attempt.diffStat ?? '',
      assistantText: attempt.assistantText ?? '',
      ...(attempt.passed || !stoppedAt ? {} : { failedCheck: stoppedAt.name }),
    };
  });

  return {
    summary: escalationSummary(verification, status),
    failingCheck: {
      name: failingCheck.name,
      command: failingCheck.command,
      exitCode: failingCheck.exitCode,
      outputTail: truncateForRecord(failingCheck.outputTail),
    },
    attempts,
  };
}
