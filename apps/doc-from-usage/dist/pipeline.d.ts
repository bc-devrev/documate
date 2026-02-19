import { TextBounds } from '@screenpipe/js';

/**
 * Shared types for session import, workflow detection, and doc generation.
 */
/** A single raw event from Screenpipe (OCR or input). */
interface RawEvent {
    timestamp: string;
    type: "ocr" | "input";
    appName?: string;
    windowName?: string;
    windowTitle?: string;
    url?: string;
    /** OCR text (for type=ocr). */
    text?: string;
    /** Input: event type (click, text, key, app_switch, window_focus, clipboard, etc.). */
    eventType?: string;
    /** Input: typed or pasted text. */
    textContent?: string;
    /** Input: click/key position. */
    x?: number;
    y?: number;
    /** Input: key code (e.g. 13 for Enter). */
    keyCode?: number;
    /** Input: element from accessibility. */
    elementRole?: string;
    elementName?: string;
    /** OCR: frame ID for screenshot. */
    frameId?: number;
}
/** Session = time-bounded group of events with metadata. */
interface Session {
    id: string;
    startTime: string;
    endTime: string;
    /** Active app/window/URL at end (or most recent). */
    activeApp?: string;
    activeWindow?: string;
    activeUrl?: string;
    events: RawEvent[];
    /** Cached frame IDs that have OCR (for screenshot lookup). */
    frameIds: number[];
}
/** A detected workflow step (user intent). */
interface WorkflowStep {
    stepNumber: number;
    action: "open_page" | "click" | "enter_text" | "navigate_menu" | "submit_form" | "other";
    target?: string;
    position?: {
        x: number;
        y: number;
    };
    frameId?: number;
    timestamp: string;
    contextText?: string;
    /** Raw event IDs or indices used for this step. */
    eventIndices?: number[];
}
/** Rendered step for documentation (with optional annotated image). */
interface RenderedStep {
    stepNumber: number;
    title: string;
    instruction: string;
    explanation?: string;
    tips?: string[];
    warnings?: string[];
    /** Annotated image buffer (PNG) or undefined. */
    imageBuffer?: Buffer;
}

interface ImportSessionOptions {
    baseUrl: string;
    startTime: string;
    endTime: string;
    appName?: string;
    windowName?: string;
    storeBaseDir: string;
    /** Gap in ms to start a new session (default 5 min). */
    gapMs?: number;
}
interface ImportSessionResult {
    sessions: Session[];
    eventsFetched: number;
}
declare function importSessions(options: ImportSessionOptions): Promise<ImportSessionResult>;

/**
 * Workflow detection: convert raw events into structured steps using heuristics.
 * - Click + nearby OCR / element name → click step
 * - Window/URL change → open_page
 * - Text input → enter_text
 * - Enter key / submit pattern → submit_form
 */

declare function detectSteps(events: RawEvent[]): WorkflowStep[];

interface RenderStepOptions {
    baseUrl: string;
    step: WorkflowStep;
    /** Optional: highlight this bounding box (from OCR text position). */
    highlightBounds?: TextBounds;
    /** Hotspot style. */
    hotspotRadius?: number;
    hotspotStroke?: string;
    hotspotStrokeWidth?: number;
}
declare function renderStepScreenshot(options: RenderStepOptions): Promise<Buffer>;
/** Fetch frame as buffer (no annotation). */
declare function fetchFrameBuffer(baseUrl: string, frameId: number): Promise<Buffer>;

interface GenerateDocFromStepsOptions {
    steps: WorkflowStep[];
    productName?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    model?: string;
}
declare function generateDocFromSteps(options: GenerateDocFromStepsOptions): Promise<RenderedStep[]>;

declare function saveSession(session: Session, baseDir: string): Promise<void>;
declare function loadSession(sessionId: string, baseDir: string): Promise<Session | null>;
declare function listSessions(baseDir: string): Promise<Session[]>;

interface PipelineOptions {
    baseUrl: string;
    startTime: string;
    endTime: string;
    appName?: string;
    windowName?: string;
    storeBaseDir: string;
    productName?: string;
    openaiApiKey?: string;
    /** If true, fetch frame and draw hotspot for each step with position+frameId. */
    renderScreenshots?: boolean;
}
interface PipelineResult {
    sessions: Session[];
    steps: WorkflowStep[];
    renderedSteps: RenderedStep[];
}
declare function runPipeline(options: PipelineOptions): Promise<PipelineResult>;

export { type PipelineOptions, type PipelineResult, type RenderedStep, type Session, type WorkflowStep, detectSteps, fetchFrameBuffer, generateDocFromSteps, importSessions, listSessions, loadSession, renderStepScreenshot, runPipeline, saveSession };
