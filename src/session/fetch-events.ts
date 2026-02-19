/**
 * Fetches OCR and input events from Screenpipe API with full fields (position, element context).
 */
import { ScreenpipeClient } from "@screenpipe/js";
import type { ContentItem, VisionContent, InputContent } from "@screenpipe/js";
import type { RawEvent } from "../core-types.js";

const DEFAULT_LIMIT = 1000;

export async function fetchEventsFromScreenpipe(options: {
  baseUrl: string;
  startTime: string;
  endTime: string;
  appName?: string;
  windowName?: string;
  limit?: number;
}): Promise<RawEvent[]> {
  const client = new ScreenpipeClient({ baseUrl: options.baseUrl });
  const limit = options.limit ?? DEFAULT_LIMIT;

  const [ocrResponse, inputResponse] = await Promise.all([
    client.search({
      startTime: options.startTime,
      endTime: options.endTime,
      contentType: "ocr",
      limit,
      appName: options.appName,
      windowName: options.windowName,
    }),
    client.search({
      startTime: options.startTime,
      endTime: options.endTime,
      contentType: "input",
      limit,
      appName: options.appName,
      windowName: options.windowName,
    }),
  ]);

  const events: RawEvent[] = [];

  for (const item of ocrResponse.data) {
    if (item.type === "OCR") {
      const c = item.content as VisionContent;
      events.push({
        timestamp: c.timestamp,
        type: "ocr",
        appName: c.appName,
        windowName: c.windowName,
        url: c.browserUrl,
        text: c.text?.slice(0, 5000),
        frameId: c.frameId,
      });
    }
  }

  for (const item of inputResponse.data) {
    if (item.type === "Input") {
      const c = item.content as InputContent;
      events.push({
        timestamp: c.timestamp,
        type: "input",
        appName: c.appName,
        windowName: c.windowTitle,
        windowTitle: c.windowTitle,
        url: c.browserUrl,
        eventType: c.eventType,
        textContent: c.textContent,
        x: c.x,
        y: c.y,
        elementRole: c.elementRole,
        elementName: c.elementName,
      });
    }
  }

  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return events;
}
