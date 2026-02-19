export interface DocFromUsageConfig {
  /** Screenpipe API base URL */
  screenpipeBaseUrl: string;
  /** App name to filter (e.g. "My App", "Chrome") */
  appName?: string;
  /** Window title substring to filter (e.g. "Dashboard") */
  windowName?: string;
  /** Start of time range (ISO string) */
  startTime: string;
  /** End of time range (ISO string) */
  endTime: string;
  /** Max search results to fetch per content type (default 100) */
  limit?: number;
  /** Output folder for documentation (can add images and edit). If set, docs written here; otherwise use outputPath. */
  outputFolder?: string;
  /** Output format: markdown (folder + .md + images/) or docx (single .docx with images) */
  outputFormat?: OutputFormat;
  /** Output markdown file path (used when outputFolder not set, or as filename inside outputFolder) */
  outputPath?: string;
  /** Product name for the doc title (default: app name or "Product") */
  productName?: string;
  /** LLM: OpenAI API key (or set OPENAI_API_KEY) */
  openaiApiKey?: string;
  /** LLM: Base URL for OpenAI-compatible API (e.g. Anthropic proxy, local) */
  openaiBaseUrl?: string;
  /** LLM model (default: gpt-5.2) */
  model?: string;
}

export interface UsageEvent {
  timestamp: string;
  type: "ocr" | "input" | "audio";
  appName?: string;
  windowName?: string;
  text?: string;
  eventType?: string;
  url?: string;
  summary?: string;
  /** Frame ID for OCR events (used to fetch screenshot) */
  frameId?: number;
  /** Inline base64 image when search was done with includeFrames (avoids separate frame fetch) */
  frameBase64?: string;
  /** Key code for key events (e.g. for screenshot shortcut) */
  keyCode?: number;
  /** Modifier bitmask for key events (e.g. 8 = Cmd on macOS) */
  modifiers?: number;
  /** Click/key position (when provided by API) */
  x?: number;
  y?: number;
  /** Element label from accessibility (when provided by API) */
  elementName?: string;
  elementRole?: string;
}

/** Output format for generated documentation */
export type OutputFormat = "markdown" | "docx";
