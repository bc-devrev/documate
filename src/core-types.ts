/**
 * Shared types for session import, workflow detection, and doc generation.
 */

/** A single raw event from Screenpipe (OCR or input). */
export interface RawEvent {
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
export interface Session {
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
export interface WorkflowStep {
  stepNumber: number;
  action: "open_page" | "click" | "enter_text" | "navigate_menu" | "submit_form" | "other";
  target?: string;
  position?: { x: number; y: number };
  frameId?: number;
  timestamp: string;
  contextText?: string;
  /** Raw event IDs or indices used for this step. */
  eventIndices?: number[];
}

/** Rendered step for documentation (with optional annotated image). */
export interface RenderedStep {
  stepNumber: number;
  title: string;
  instruction: string;
  explanation?: string;
  tips?: string[];
  warnings?: string[];
  /** Annotated image buffer (PNG) or undefined. */
  imageBuffer?: Buffer;
}
