/**
 * Workflow detection: convert raw events into structured steps using heuristics.
 * - Click + nearby OCR / element name → click step
 * - Window/URL change → open_page
 * - Text input → enter_text
 * - Enter key / submit pattern → submit_form
 */
import type { RawEvent, WorkflowStep } from "../core-types.js";

const ENTER_KEY_CODES = [36, 76]; // Return/Enter variants
const MAX_MS_NEARBY_OCR = 3000; // use OCR within 3s for context

export function detectSteps(events: RawEvent[]): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  let stepNumber = 0;
  let lastUrl: string | undefined;
  let lastWindow: string | undefined;
  let lastApp: string | undefined;

  const ocrEvents = events.filter((e) => e.type === "ocr");

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const action = (e.type === "input" && e.eventType) ? e.eventType.toLowerCase() : "";

    if (e.type === "input" && action === "app_switch") {
      stepNumber++;
      steps.push({
        stepNumber,
        action: "open_page",
        target: e.appName ?? e.windowName,
        timestamp: e.timestamp,
        contextText: e.appName ? `Switched to ${e.appName}` : undefined,
        eventIndices: [i],
      });
      lastApp = e.appName;
      lastWindow = e.windowName ?? e.windowTitle;
      continue;
    }

    if (e.type === "input") {
      if (action === "window_focus" && (e.windowTitle || e.windowName)) {
        if (e.windowTitle !== lastWindow || e.windowName !== lastWindow) {
          stepNumber++;
          steps.push({
            stepNumber,
            action: "open_page",
            target: e.windowTitle ?? e.windowName,
            timestamp: e.timestamp,
            contextText: e.windowTitle ? `Focused: ${e.windowTitle}` : undefined,
            eventIndices: [i],
          });
          lastWindow = e.windowTitle ?? e.windowName;
        }
        continue;
      }

      if (action === "click" && (e.x != null && e.y != null)) {
        const frameId = findNearestFrameId(events, i, ocrEvents);
        const contextText = e.elementName ?? findNearbyOcrText(ocrEvents, e.timestamp, e.x, e.y);
        stepNumber++;
        steps.push({
          stepNumber,
          action: "click",
          target: e.elementName ?? contextText ?? "button",
          position: { x: e.x, y: e.y },
          frameId,
          timestamp: e.timestamp,
          contextText: contextText ?? e.elementRole,
          eventIndices: [i],
        });
        continue;
      }

      if (action === "text" && e.textContent) {
        stepNumber++;
        steps.push({
          stepNumber,
          action: "enter_text",
          target: e.textContent.slice(0, 80),
          timestamp: e.timestamp,
          contextText: e.textContent,
          eventIndices: [i],
        });
        continue;
      }

      if (action === "key" && e.keyCode && ENTER_KEY_CODES.includes(e.keyCode)) {
        stepNumber++;
        steps.push({
          stepNumber,
          action: "submit_form",
          target: "Submit (Enter)",
          timestamp: e.timestamp,
          contextText: "Pressed Enter",
          eventIndices: [i],
        });
        continue;
      }

      if (e.url && e.url !== lastUrl) {
        lastUrl = e.url;
        stepNumber++;
        steps.push({
          stepNumber,
          action: "open_page",
          target: e.url,
          timestamp: e.timestamp,
          contextText: e.windowTitle ?? e.url,
          eventIndices: [i],
        });
      }
    }
  }

  return steps;
}

function findNearestFrameId(events: RawEvent[], inputIndex: number, ocrEvents: RawEvent[]): number | undefined {
  const inputTs = new Date(events[inputIndex].timestamp).getTime();
  let best: RawEvent | null = null;
  let bestDelta = Infinity;
  for (const ocr of ocrEvents) {
    if (ocr.frameId == null) continue;
    const delta = Math.abs(new Date(ocr.timestamp).getTime() - inputTs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = ocr;
    }
  }
  return best?.frameId;
}

function findNearbyOcrText(ocrEvents: RawEvent[], timestamp: string, x: number, y: number): string | undefined {
  const ts = new Date(timestamp).getTime();
  for (const ocr of ocrEvents) {
    const ot = new Date(ocr.timestamp).getTime();
    if (Math.abs(ot - ts) > MAX_MS_NEARBY_OCR) continue;
    if (ocr.text && ocr.text.length < 200) return ocr.text.slice(0, 100);
  }
  return undefined;
}
