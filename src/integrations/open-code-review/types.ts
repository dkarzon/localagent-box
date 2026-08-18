export interface OcrComment {
  path?: string;
  file?: string;
  content: string;
  start_line?: number;
  end_line?: number;
  suggestion_code?: string;
  existing_code?: string;
  thinking?: string;
}

export interface OcrRunSummary {
  files_reviewed?: number;
  comments?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  elapsed?: string;
}

export interface OcrCoverageItem {
  path: string;
  old_path?: string;
  classification?: string;
  reason?: string;
}

export interface OcrToolCalls {
  total?: number;
  by_tool?: Record<string, number>;
}

export interface OcrRetryReport {
  total_requests?: number;
  failed_requests?: number;
  retried_requests?: number;
  total_retries?: number;
  requests?: Array<{
    file_path?: string;
    outcome?: string;
    task_type?: string;
    request_no?: number;
    attempts?: Array<{
      error_class?: string;
      failure_phase?: string;
      duration_to_headers_ms?: number;
    }>;
  }>;
}

export interface OcrReviewEnvelope {
  status?: string;
  message?: string;
  summary?: OcrRunSummary | string;
  comments?: OcrComment[];
  /** Legacy shape from early integration */
  issues?: Array<{ file?: string; line?: number; message: string }>;
  warnings?: Array<{ path?: string; message?: string }>;
  tool_calls?: OcrToolCalls;
  llm?: { model?: string };
  session_id?: string;
  retry_report?: OcrRetryReport;
  manifest?: {
    coverage?: {
      selected?: OcrCoverageItem[];
      completed?: OcrCoverageItem[];
      failed?: OcrCoverageItem[];
      waived?: OcrCoverageItem[];
      reused?: OcrCoverageItem[];
    };
    execution?: {
      model?: string;
      ocr_version?: string;
      configured_concurrency?: number;
    };
    input?: {
      requested_from?: string;
      requested_head?: string;
      resolved_base?: string;
      resolved_head?: string;
      exact_range?: string;
    };
    elapsed_ms?: number;
    terminal_state?: string;
  };
}
