// src/session/fetch-events.ts
import { ScreenpipeClient } from "@screenpipe/js";
var DEFAULT_LIMIT = 1e3;
async function fetchEventsFromScreenpipe(options) {
  const client = new ScreenpipeClient({ baseUrl: options.baseUrl });
  const limit = options.limit ?? DEFAULT_LIMIT;
  const [ocrResponse, inputResponse] = await Promise.all([
    client.search({
      startTime: options.startTime,
      endTime: options.endTime,
      contentType: "ocr",
      limit,
      appName: options.appName,
      windowName: options.windowName
    }),
    client.search({
      startTime: options.startTime,
      endTime: options.endTime,
      contentType: "input",
      limit,
      appName: options.appName,
      windowName: options.windowName
    })
  ]);
  const events = [];
  for (const item of ocrResponse.data) {
    if (item.type === "OCR") {
      const c = item.content;
      events.push({
        timestamp: c.timestamp,
        type: "ocr",
        appName: c.appName,
        windowName: c.windowName,
        url: c.browserUrl,
        text: c.text?.slice(0, 5e3),
        frameId: c.frameId
      });
    }
  }
  for (const item of inputResponse.data) {
    if (item.type === "Input") {
      const c = item.content;
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
        elementName: c.elementName
      });
    }
  }
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return events;
}

// src/session/group-sessions.ts
import { randomUUID } from "crypto";
var DEFAULT_GAP_MS = 5 * 60 * 1e3;
function groupEventsIntoSessions(events, options) {
  const gapMs = options?.gapMs ?? DEFAULT_GAP_MS;
  if (events.length === 0) return [];
  const sessions = [];
  let current = [events[0]];
  let startTime = events[0].timestamp;
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    const prevMs = new Date(prev.timestamp).getTime();
    const currMs = new Date(curr.timestamp).getTime();
    if (currMs - prevMs > gapMs) {
      sessions.push(buildSession(randomUUID(), startTime, prev.timestamp, current));
      current = [curr];
      startTime = curr.timestamp;
    } else {
      current.push(curr);
    }
  }
  const last = current[current.length - 1];
  sessions.push(buildSession(randomUUID(), startTime, last.timestamp, current));
  return sessions;
}
function buildSession(id, startTime, endTime, events) {
  const frameIds = [...new Set(events.filter((e) => e.frameId != null).map((e) => e.frameId))];
  const last = events[events.length - 1];
  return {
    id,
    startTime,
    endTime,
    activeApp: last?.appName,
    activeWindow: last?.windowName ?? last?.windowTitle,
    activeUrl: last?.url,
    events,
    frameIds
  };
}

// src/session/session-store.ts
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
var SESSIONS_DIR = "sessions";
var INDEX_FILE = "index.json";
function getSessionsDir(baseDir) {
  return join(baseDir, SESSIONS_DIR);
}
async function ensureStore(baseDir) {
  await mkdir(getSessionsDir(baseDir), { recursive: true });
}
async function saveSession(session, baseDir) {
  await ensureStore(baseDir);
  const path = join(getSessionsDir(baseDir), `${session.id}.json`);
  await writeFile(path, JSON.stringify(session, null, 0), "utf-8");
  const indexPath = join(getSessionsDir(baseDir), INDEX_FILE);
  let index = { ids: [] };
  try {
    const raw = await readFile(indexPath, "utf-8");
    index = JSON.parse(raw);
  } catch {
  }
  if (!index.ids.includes(session.id)) {
    index.ids.push(session.id);
    index.ids.sort();
    await writeFile(indexPath, JSON.stringify(index, null, 0), "utf-8");
  }
}
async function loadSession(sessionId, baseDir) {
  const path = join(getSessionsDir(baseDir), `${sessionId}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function listSessionIds(baseDir) {
  const indexPath = join(getSessionsDir(baseDir), INDEX_FILE);
  try {
    const raw = await readFile(indexPath, "utf-8");
    const index = JSON.parse(raw);
    return index.ids ?? [];
  } catch {
    return [];
  }
}
async function listSessions(baseDir) {
  const ids = await listSessionIds(baseDir);
  const sessions = [];
  for (const id of ids) {
    const s = await loadSession(id, baseDir);
    if (s) sessions.push(s);
  }
  return sessions.sort((a, b) => b.startTime.localeCompare(a.startTime));
}

// src/session/import-session.ts
async function importSessions(options) {
  const events = await fetchEventsFromScreenpipe({
    baseUrl: options.baseUrl,
    startTime: options.startTime,
    endTime: options.endTime,
    appName: options.appName,
    windowName: options.windowName
  });
  const sessions = groupEventsIntoSessions(events, { gapMs: options.gapMs });
  await ensureStore(options.storeBaseDir);
  for (const session of sessions) {
    await saveSession(session, options.storeBaseDir);
  }
  return { sessions, eventsFetched: events.length };
}

// src/workflow/detect-steps.ts
var ENTER_KEY_CODES = [36, 76];
var MAX_MS_NEARBY_OCR = 3e3;
function detectSteps(events) {
  const steps = [];
  let stepNumber = 0;
  let lastUrl;
  let lastWindow;
  let lastApp;
  const ocrEvents = events.filter((e) => e.type === "ocr");
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const action = e.type === "input" && e.eventType ? e.eventType.toLowerCase() : "";
    if (e.type === "input" && action === "app_switch") {
      stepNumber++;
      steps.push({
        stepNumber,
        action: "open_page",
        target: e.appName ?? e.windowName,
        timestamp: e.timestamp,
        contextText: e.appName ? `Switched to ${e.appName}` : void 0,
        eventIndices: [i]
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
            contextText: e.windowTitle ? `Focused: ${e.windowTitle}` : void 0,
            eventIndices: [i]
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
          eventIndices: [i]
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
          eventIndices: [i]
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
          eventIndices: [i]
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
          eventIndices: [i]
        });
      }
    }
  }
  return steps;
}
function findNearestFrameId(events, inputIndex, ocrEvents) {
  const inputTs = new Date(events[inputIndex].timestamp).getTime();
  let best = null;
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
function findNearbyOcrText(ocrEvents, timestamp, x, y) {
  const ts = new Date(timestamp).getTime();
  for (const ocr of ocrEvents) {
    const ot = new Date(ocr.timestamp).getTime();
    if (Math.abs(ot - ts) > MAX_MS_NEARBY_OCR) continue;
    if (ocr.text && ocr.text.length < 200) return ocr.text.slice(0, 100);
  }
  return void 0;
}

// src/screenshot/render-step.ts
import sharp from "sharp";
import { ScreenpipeClient as ScreenpipeClient2 } from "@screenpipe/js";
var DEFAULT_RADIUS = 16;
var DEFAULT_STROKE = "#e11";
var DEFAULT_STROKE_WIDTH = 3;
async function renderStepScreenshot(options) {
  const {
    baseUrl,
    step,
    highlightBounds,
    hotspotRadius = DEFAULT_RADIUS,
    hotspotStroke = DEFAULT_STROKE,
    hotspotStrokeWidth = DEFAULT_STROKE_WIDTH
  } = options;
  const client = new ScreenpipeClient2({ baseUrl });
  let imageBuffer;
  if (step.frameId != null) {
    const res = await client.getFrame(step.frameId);
    if (!res.ok) throw new Error(`Failed to fetch frame ${step.frameId}: ${res.status}`);
    imageBuffer = Buffer.from(await res.arrayBuffer());
  } else {
    throw new Error("Step has no frameId; cannot render screenshot.");
  }
  const meta = await sharp(imageBuffer).metadata();
  const width = meta.width ?? 1;
  const height = meta.height ?? 1;
  const overlays = [];
  if (step.position && step.position.x != null && step.position.y != null) {
    const cx = step.position.x;
    const cy = step.position.y;
    const r = hotspotRadius;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${hotspotStroke}" stroke-width="${hotspotStrokeWidth}"/>
    </svg>`;
    overlays.push(await sharp(Buffer.from(svg)).png().toBuffer());
  }
  if (highlightBounds) {
    const { left, top, width: w, height: h } = highlightBounds;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${left}" y="${top}" width="${w}" height="${h}" fill="none" stroke="#28a745" stroke-width="2" stroke-dasharray="4"/>
    </svg>`;
    overlays.push(await sharp(Buffer.from(svg)).png().toBuffer());
  }
  if (overlays.length === 0) return imageBuffer;
  let result = sharp(imageBuffer);
  for (const overlay of overlays) {
    result = result.composite([{ input: overlay, blend: "over" }]);
  }
  return result.png().toBuffer();
}
async function fetchFrameBuffer(baseUrl, frameId) {
  const client = new ScreenpipeClient2({ baseUrl });
  const res = await client.getFrame(frameId);
  if (!res.ok) throw new Error(`Failed to fetch frame ${frameId}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// src/doc-from-steps/generate-doc.ts
import OpenAI from "openai";
var DEFAULT_MODEL = "gpt-5.2";
function stepsToPromptText(steps) {
  return steps.map((s, i) => {
    const parts = [
      `Step ${s.stepNumber}: action=${s.action}`,
      s.target ? `target="${s.target}"` : "",
      s.position ? `position=(${s.position.x},${s.position.y})` : "",
      s.contextText ? `context="${s.contextText.slice(0, 200)}"` : ""
    ].filter(Boolean);
    return parts.join(", ");
  }).join("\n");
}
async function generateDocFromSteps(options) {
  const apiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI API key not set. Set OPENAI_API_KEY or pass openaiApiKey.");
  }
  const client = new OpenAI({
    apiKey,
    baseURL: options.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? void 0
  });
  const model = options.model ?? process.env.DOC_FROM_USAGE_MODEL ?? DEFAULT_MODEL;
  const stepsText = stepsToPromptText(options.steps);
  const productName = options.productName ?? "the product";
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: `You are a technical writer. You are given a list of workflow steps (actions like click, enter_text, open_page, submit_form) detected from a user's session in ${productName}.

For each step, output a JSON array of objects. Each object must have:
- title: short step title (e.g. "Click the Create button")
- instruction: one clear instruction sentence (e.g. "Click the Create button in the toolbar.")
- explanation: (optional) one sentence why this step matters
- tips: (optional) array of strings with helpful tips
- warnings: (optional) array of strings with cautions

Keep instructions concise and actionable. Use the step's target and context to make titles and instructions specific. Output only the JSON array, no markdown.`
      },
      {
        role: "user",
        content: `Product: ${productName}

Steps:
${stepsText}

Output a JSON array with one object per step, in order. Keys: title, instruction, explanation (optional), tips (optional), warnings (optional).`
      }
    ],
    max_completion_tokens: 4096
  });
  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error("LLM returned no content");
  let parsed;
  try {
    const jsonStr = content.replace(/^```json?\s*|\s*```$/g, "").trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("LLM did not return valid JSON array");
  }
  const rendered = [];
  for (let i = 0; i < options.steps.length; i++) {
    const step = options.steps[i];
    const p = parsed[i] ?? {};
    rendered.push({
      stepNumber: step.stepNumber,
      title: p.title ?? `Step ${step.stepNumber}`,
      instruction: p.instruction ?? step.target ?? step.action,
      explanation: p.explanation,
      tips: p.tips,
      warnings: p.warnings
    });
  }
  return rendered;
}

// src/pipeline.ts
async function runPipeline(options) {
  const { baseUrl, storeBaseDir, productName, openaiApiKey, renderScreenshots = false } = options;
  const { sessions } = await importSessions({
    baseUrl,
    startTime: options.startTime,
    endTime: options.endTime,
    appName: options.appName,
    windowName: options.windowName,
    storeBaseDir
  });
  if (sessions.length === 0) {
    return { sessions: [], steps: [], renderedSteps: [] };
  }
  const session = sessions[0];
  const steps = detectSteps(session.events);
  const renderedSteps = await generateDocFromSteps({
    steps,
    productName,
    openaiApiKey
  });
  if (renderScreenshots && baseUrl) {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.frameId != null && step.position) {
        try {
          const buf = await renderStepScreenshot({ baseUrl, step });
          renderedSteps[i].imageBuffer = buf;
        } catch {
        }
      }
    }
  }
  return { sessions, steps, renderedSteps };
}
export {
  detectSteps,
  fetchFrameBuffer,
  generateDocFromSteps,
  importSessions,
  listSessions,
  loadSession,
  renderStepScreenshot,
  runPipeline,
  saveSession
};
