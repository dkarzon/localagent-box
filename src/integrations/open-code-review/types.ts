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
}

export interface OcrReviewEnvelope {
  status?: string;
  message?: string;
  summary?: OcrRunSummary | string;
  comments?: OcrComment[];
  /** Legacy shape from early integration */
  issues?: Array<{ file?: string; line?: number; message: string }>;
  warnings?: Array<{ path?: string; message?: string }>;
  llm?: { model?: string };
  session_id?: string;
  manifest?: {
    coverage?: {
      selected?: OcrCoverageItem[];
      completed?: OcrCoverageItem[];
      failed?: OcrCoverageItem[];
    };
    execution?: {
      model?: string;
      ocr_version?: string;
    };
    input?: {
      requested_from?: string;
      requested_head?: string;
    };
    elapsed_ms?: number;
  };
}
