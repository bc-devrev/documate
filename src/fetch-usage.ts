import { ScreenpipeClient } from "@screenpipe/js";
import type { VisionContent, InputContent, AudioContent } from "@screenpipe/js";
import type { UsageEvent } from "./types.js";

const DEFAULT_LIMIT = 500;

/** When user filters by "Chrome", also fetch "Google Chrome" (macOS often uses that). */
function appNameVariants(appName: string | undefined): string[] {
  if (!appName?.trim()) return [];
  const n = appName.trim();
  if (n === "Chrome") return ["Chrome", "Google Chrome"];
  return [n];
}

export async function fetchUsageEvents(options: {
  baseUrl: string;
  appName?: string;
  windowName?: string;
  startTime: string;
  endTime: string;
  limit?: number;
  /** When true, OCR search includes inline frame images (for screenshots without separate GET /frames/:id) */
  includeFrames?: boolean;
}): Promise<UsageEvent[]> {
  const client = new ScreenpipeClient({ baseUrl: options.baseUrl });
  const limit = options.limit ?? DEFAULT_LIMIT;
  const appNames = appNameVariants(options.appName);
  const includeFrames = options.includeFrames === true;

  const base = {
    startTime: options.startTime,
    endTime: options.endTime,
    windowName: options.windowName,
    limit,
  };

  if (appNames.length === 0) {
    const [ocrResponse, inputResponse, audioResponse] = await Promise.all([
      client.search({ ...base, contentType: "ocr", includeFrames }),
      client.search({ ...base, contentType: "input" }),
      client.search({ ...base, contentType: "audio" }),
    ]);
    const events = normalizeEvents(ocrResponse.data, inputResponse.data, audioResponse.data);
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return events;
  }

  const ocrPromises = appNames.map((appName) =>
    client.search({ ...base, contentType: "ocr", appName, includeFrames })
  );
  const inputPromises = appNames.map((appName) =>
    client.search({ ...base, contentType: "input", appName })
  );
  const audioPromise = client.search({ ...base, contentType: "audio" });
  const [ocrResults, inputResults, audioResponse] = await Promise.all([
    Promise.all(ocrPromises),
    Promise.all(inputPromises),
    audioPromise,
  ]);

  const allOcr = ocrResults.flatMap((r) => r.data);
  const allInput = inputResults.flatMap((r) => r.data);
  const events = normalizeEvents(allOcr, allInput, audioResponse.data);

  const byFrameId = new Map<number, UsageEvent>();
  for (const e of events) {
    if (e.type === "ocr" && e.frameId != null) {
      const existing = byFrameId.get(e.frameId);
      const prefer = !existing
        || (e.frameBase64 && !existing.frameBase64)
        || (existing.timestamp < e.timestamp && !(existing.frameBase64 && !e.frameBase64));
      if (prefer) byFrameId.set(e.frameId, e);
    }
  }
  const dedupedOcr = Array.from(byFrameId.values());
  const inputEvents = events.filter((e) => e.type === "input");
  const audioEvents = events.filter((e) => e.type === "audio");
  const merged = [...dedupedOcr, ...inputEvents, ...audioEvents];
  merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return merged;
}

function normalizeEvents(
  ocrItems: { type: string; content?: unknown }[],
  inputItems: { type: string; content?: unknown }[],
  audioItems: { type: string; content?: unknown }[] = []
): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const item of ocrItems) {
    if (item.type === "OCR" && item.content) {
      const c = item.content as VisionContent & { frame_id?: number };
      const frameId = c.frameId ?? c.frame_id;
      const frameBase64 = typeof c.frame === "string" && c.frame.length > 0 ? c.frame : undefined;
      events.push({
        timestamp: c.timestamp,
        type: "ocr",
        appName: c.appName,
        windowName: c.windowName,
        text: c.text?.slice(0, 2000),
        url: c.browserUrl,
        frameId: frameId != null ? Number(frameId) : undefined,
        frameBase64,
      });
    }
  }
  for (const item of inputItems) {
    if (item.type === "Input" && item.content) {
      const c = item.content as InputContent & { event_type?: string; key_code?: number; modifiers?: number };
      const raw = c as unknown as Record<string, unknown>;
      events.push({
        timestamp: c.timestamp,
        type: "input",
        appName: c.appName,
        windowName: c.windowTitle,
        eventType: c.eventType ?? c.event_type,
        text: c.textContent,
        url: c.browserUrl,
        keyCode: c.keyCode ?? c.key_code ?? (typeof raw.key_code === "number" ? raw.key_code : undefined),
        modifiers: c.modifiers ?? (typeof raw.modifiers === "number" ? raw.modifiers : undefined),
        x: c.x,
        y: c.y,
        elementName: c.elementName,
        elementRole: c.elementRole,
      });
    }
  }
  for (const item of audioItems) {
    const typ = (item as { type?: string }).type;
    if ((typ === "Audio" || typ === "audio") && item.content) {
      const c = item.content as AudioContent & { transcription?: string };
      const raw = c as unknown as Record<string, unknown>;
      const t = (c.transcription ?? raw.transcription ?? "").trim();
      if (!t) continue;
      const ts = c.timestamp ?? raw.timestamp;
      if (!ts) continue;
      events.push({
        timestamp: typeof ts === "string" ? ts : new Date(ts as number).toISOString(),
        type: "audio",
        text: t.slice(0, 2000),
      });
    }
  }
  return events;
}
