interface DocFromUsageConfig {
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
interface UsageEvent {
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
type OutputFormat = "markdown" | "docx";

declare function fetchUsageEvents(options: {
    baseUrl: string;
    appName?: string;
    windowName?: string;
    startTime: string;
    endTime: string;
    limit?: number;
    /** When true, OCR search includes inline frame images (for screenshots without separate GET /frames/:id) */
    includeFrames?: boolean;
}): Promise<UsageEvent[]>;

declare function generateDocumentation(options: {
    events: UsageEvent[];
    productName: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    model?: string;
    /** Context for each screenshot (in order) so the LLM can place them in the right section/step */
    screenshotContexts?: string[];
}): Promise<string>;

/**
 * Write documentation to a folder: markdown + images subfolder, or single .docx with images.
 */

interface WriteDocsOptions {
    /** Resolved output folder (e.g. /Users/me/Docs/MyProduct) */
    outputFolder: string;
    /** "markdown" or "docx" */
    outputFormat: "markdown" | "docx";
    /** Product name for filename/title */
    productName: string;
    /** Generated markdown body (from LLM) */
    markdownBody: string;
    /** Time range for subtitle */
    startTime: string;
    endTime: string;
    /** Usage events (for picking screenshots) */
    events: UsageEvent[];
    /** Screenpipe API base URL for fetching frames */
    baseUrl?: string;
}
declare function writeDocsToFolder(options: WriteDocsOptions): Promise<{
    path: string;
    imagesCount: number;
    framesFailed?: number;
}>;

/**
 * Main entry: fetch usage from Screenpipe, generate docs with AI, write to folder (or single file).
 * When outputFolder is set (or from saved config), writes to that folder with images; otherwise uses outputPath.
 */
declare function runDocFromUsage(config: DocFromUsageConfig): Promise<{
    outputPath: string;
    eventsCount: number;
    imagesCount?: number;
}>;

export { type DocFromUsageConfig, type UsageEvent, fetchUsageEvents, generateDocumentation, runDocFromUsage, writeDocsToFolder };
