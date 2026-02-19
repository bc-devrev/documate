// src/fetch-usage.ts
import { ScreenpipeClient } from "@screenpipe/js";
var DEFAULT_LIMIT = 500;
function appNameVariants(appName) {
  if (!appName?.trim()) return [];
  const n = appName.trim();
  if (n === "Chrome") return ["Chrome", "Google Chrome"];
  return [n];
}
async function fetchUsageEvents(options) {
  const client = new ScreenpipeClient({ baseUrl: options.baseUrl });
  const limit = options.limit ?? DEFAULT_LIMIT;
  const appNames = appNameVariants(options.appName);
  const includeFrames = options.includeFrames === true;
  const base = {
    startTime: options.startTime,
    endTime: options.endTime,
    windowName: options.windowName,
    limit
  };
  if (appNames.length === 0) {
    const [ocrResponse, inputResponse, audioResponse2] = await Promise.all([
      client.search({ ...base, contentType: "ocr", includeFrames }),
      client.search({ ...base, contentType: "input" }),
      client.search({ ...base, contentType: "audio" })
    ]);
    const events2 = normalizeEvents(ocrResponse.data, inputResponse.data, audioResponse2.data);
    events2.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return events2;
  }
  const ocrPromises = appNames.map(
    (appName) => client.search({ ...base, contentType: "ocr", appName, includeFrames })
  );
  const inputPromises = appNames.map(
    (appName) => client.search({ ...base, contentType: "input", appName })
  );
  const audioPromise = client.search({ ...base, contentType: "audio" });
  const [ocrResults, inputResults, audioResponse] = await Promise.all([
    Promise.all(ocrPromises),
    Promise.all(inputPromises),
    audioPromise
  ]);
  const allOcr = ocrResults.flatMap((r) => r.data);
  const allInput = inputResults.flatMap((r) => r.data);
  const events = normalizeEvents(allOcr, allInput, audioResponse.data);
  const byFrameId = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.type === "ocr" && e.frameId != null) {
      const existing = byFrameId.get(e.frameId);
      const prefer = !existing || e.frameBase64 && !existing.frameBase64 || existing.timestamp < e.timestamp && !(existing.frameBase64 && !e.frameBase64);
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
function normalizeEvents(ocrItems, inputItems, audioItems = []) {
  const events = [];
  for (const item of ocrItems) {
    if (item.type === "OCR" && item.content) {
      const c = item.content;
      const frameId = c.frameId ?? c.frame_id;
      const frameBase64 = typeof c.frame === "string" && c.frame.length > 0 ? c.frame : void 0;
      events.push({
        timestamp: c.timestamp,
        type: "ocr",
        appName: c.appName,
        windowName: c.windowName,
        text: c.text?.slice(0, 2e3),
        url: c.browserUrl,
        frameId: frameId != null ? Number(frameId) : void 0,
        frameBase64
      });
    }
  }
  for (const item of inputItems) {
    if (item.type === "Input" && item.content) {
      const c = item.content;
      const raw = c;
      events.push({
        timestamp: c.timestamp,
        type: "input",
        appName: c.appName,
        windowName: c.windowTitle,
        eventType: c.eventType ?? c.event_type,
        text: c.textContent,
        url: c.browserUrl,
        keyCode: c.keyCode ?? c.key_code ?? (typeof raw.key_code === "number" ? raw.key_code : void 0),
        modifiers: c.modifiers ?? (typeof raw.modifiers === "number" ? raw.modifiers : void 0),
        x: c.x,
        y: c.y,
        elementName: c.elementName,
        elementRole: c.elementRole
      });
    }
  }
  for (const item of audioItems) {
    const typ = item.type;
    if ((typ === "Audio" || typ === "audio") && item.content) {
      const c = item.content;
      const raw = c;
      const t = (c.transcription ?? raw.transcription ?? "").trim();
      if (!t) continue;
      const ts = c.timestamp ?? raw.timestamp;
      if (!ts) continue;
      events.push({
        timestamp: typeof ts === "string" ? ts : new Date(ts).toISOString(),
        type: "audio",
        text: t.slice(0, 2e3)
      });
    }
  }
  return events;
}

// src/generate-docs.ts
import OpenAI from "openai";

// src/step-extraction.ts
var CLUSTER_WINDOW_MS = 3e3;
var DUPLICATE_CLICK_MS = 300;
var SAME_SCREEN_OCR_MS = 2e3;
var MERGE_MICRO_STEP_MS = 5e3;
var MAX_OCR_FOR_LABEL = 400;
function isDocFromUsage(e) {
  const w = (e.window ?? "").toLowerCase();
  const u = (e.url ?? "").toLowerCase();
  return w.includes("doc from usage") || u.includes("localhost:3040");
}
function normalizeEvents2(events) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const ts = new Date(e.timestamp).getTime();
    const app = (e.appName ?? "").trim();
    const window = (e.windowName ?? "").trim();
    const url = (e.url ?? "").trim();
    const text = (e.text ?? "").trim().toLowerCase();
    const ocrText = e.type === "ocr" ? (e.text ?? "").trim() : void 0;
    if (e.type === "ocr") {
      out.push({
        timestamp: ts,
        type: "screen",
        app,
        window,
        url: url || void 0,
        ocrText: ocrText || void 0,
        text: text.slice(0, MAX_OCR_FOR_LABEL) || void 0,
        eventIndex: i
      });
      continue;
    }
    if (e.type === "audio") {
      out.push({
        timestamp: ts,
        type: "speech",
        app,
        window,
        text: (e.text ?? "").trim() || void 0,
        eventIndex: i
      });
      continue;
    }
    const et = (e.eventType ?? "").toLowerCase();
    if (et === "scroll") {
      out.push({ timestamp: ts, type: "scroll", app, window, eventIndex: i });
      continue;
    }
    if (et === "window_focus" || et === "app_switch") {
      out.push({
        timestamp: ts,
        type: "focus",
        app,
        window,
        url: url || void 0,
        eventIndex: i
      });
      continue;
    }
    if (et === "click") {
      out.push({
        timestamp: ts,
        type: "click",
        app,
        window,
        url: url || void 0,
        elementName: (e.elementName ?? e.text ?? "").trim() || void 0,
        x: e.x,
        y: e.y,
        eventIndex: i
      });
      continue;
    }
    out.push({
      timestamp: ts,
      type: "key",
      app,
      window,
      url: url || void 0,
      text: (e.text ?? "").trim() || void 0,
      eventIndex: i
    });
  }
  return out;
}
function filterNoise(normalized) {
  const out = [];
  let lastScreenText = null;
  let lastScreenTs = 0;
  let lastClickKey = null;
  let lastClickTs = 0;
  for (const e of normalized) {
    if (e.type === "scroll") continue;
    if (e.type === "speech") {
      out.push(e);
      continue;
    }
    if (e.type === "click") {
      const key = `${e.app}|${e.window}`;
      const now = e.timestamp;
      if (lastClickKey === key && now - lastClickTs < DUPLICATE_CLICK_MS) continue;
      lastClickKey = key;
      lastClickTs = now;
      out.push(e);
      continue;
    }
    if (e.type === "screen") {
      const textSig = (e.ocrText ?? e.text ?? "").slice(0, 200);
      if (textSig && lastScreenText === textSig && e.timestamp - lastScreenTs < SAME_SCREEN_OCR_MS) continue;
      lastScreenText = textSig || null;
      lastScreenTs = e.timestamp;
      out.push(e);
      continue;
    }
    out.push(e);
  }
  return out;
}
function clusterByTime(events) {
  const clusters = [];
  let current = [];
  let lastTs = 0;
  for (const e of events) {
    if (current.length === 0) {
      current.push(e);
      lastTs = e.timestamp;
      continue;
    }
    if (e.timestamp - lastTs <= CLUSTER_WINDOW_MS) {
      current.push(e);
      lastTs = e.timestamp;
    } else {
      if (current.length > 0) clusters.push(current);
      current = [e];
      lastTs = e.timestamp;
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}
function primaryAction(cluster) {
  const hasClick = cluster.some((e) => e.type === "click");
  if (hasClick) return "click";
  const hasKey = cluster.some((e) => e.type === "key" && (e.text ?? "").length > 0);
  if (hasKey) return "key";
  const hasFocus = cluster.some((e) => e.type === "focus");
  if (hasFocus) return "focus";
  return "screen";
}
function extractTargetLabel(cluster, action, events) {
  const clickEv = cluster.find((e) => e.type === "click");
  if (clickEv?.elementName) return clickEv.elementName.trim();
  if (clickEv && (clickEv.x != null || clickEv.y != null)) {
    const screenInCluster = cluster.filter((e) => e.type === "screen");
    const best = screenInCluster[screenInCluster.length - 1];
    if (best?.ocrText) {
      const snippet = best.ocrText.slice(0, 200).replace(/\s+/g, " ").trim();
      if (snippet) return snippet;
    }
  }
  const speech = cluster.find((e) => e.type === "speech");
  if (speech?.text) return speech.text.slice(0, 80).trim();
  const withUrl = cluster.find((e) => e.url);
  if (withUrl?.url) {
    try {
      const u = new URL(withUrl.url);
      return u.pathname !== "/" ? u.pathname.slice(1) : u.hostname;
    } catch {
      return withUrl.url.slice(0, 60);
    }
  }
  const withWindow = cluster.find((e) => e.window);
  if (withWindow?.window) return withWindow.window.slice(0, 60);
  if (action === "key") {
    const keyEv = cluster.find((e) => e.type === "key" && e.text);
    if (keyEv?.text) return keyEv.text.slice(0, 60);
  }
  return void 0;
}
function closestFrameId(events, timeMs) {
  let best = null;
  for (const e of events) {
    if (e.type !== "ocr" || e.frameId == null) continue;
    const delta = Math.abs(new Date(e.timestamp).getTime() - timeMs);
    if (best == null || delta < best.delta) best = { frameId: e.frameId, delta };
  }
  return best?.frameId;
}
function mergeMicroSteps(steps, clusterEvents) {
  const merged = [];
  let i = 0;
  while (i < steps.length) {
    const cur = steps[i];
    const curCluster = clusterEvents[i];
    const curMid = curCluster.length ? curCluster.reduce((s, e) => s + e.timestamp, 0) / curCluster.length : cur.timestamp;
    if (cur.primaryAction === "click" && i + 1 < steps.length) {
      const next = steps[i + 1];
      const nextCluster = clusterEvents[i + 1];
      const nextMid = nextCluster.length ? nextCluster.reduce((s, e) => s + e.timestamp, 0) / nextCluster.length : next.timestamp;
      if (next.primaryAction === "key" && nextMid - curMid <= MERGE_MICRO_STEP_MS && curCluster[0]?.window === nextCluster[0]?.window) {
        merged.push({
          primaryAction: "key",
          target: next.target ?? "details",
          timestamp: cur.timestamp,
          frameId: cur.frameId ?? next.frameId,
          position: cur.position ?? next.position,
          eventIndices: [...cur.eventIndices ?? [], ...next.eventIndices ?? []]
        });
        i += 2;
        continue;
      }
    }
    merged.push(cur);
    i++;
  }
  return merged;
}
function extractRawSteps(events) {
  if (events.length === 0) return [];
  const normalized = normalizeEvents2(events);
  const filtered = filterNoise(normalized).filter((e) => !isDocFromUsage(e));
  if (filtered.length === 0) return [];
  const clusters = clusterByTime(filtered);
  const stepsWithoutNumber = [];
  const clusterList = [];
  for (const cluster of clusters) {
    const primaryActionType = primaryAction(cluster);
    if (primaryActionType === "screen" && cluster.every((e) => e.type === "screen")) continue;
    const target = extractTargetLabel(cluster, primaryActionType, events);
    const midTs = cluster.length > 0 ? cluster.reduce((s, e) => s + e.timestamp, 0) / cluster.length : cluster[0]?.timestamp ?? 0;
    const frameId = closestFrameId(events, midTs);
    const clickEv = cluster.find((e) => e.type === "click");
    const position = clickEv && clickEv.x != null && clickEv.y != null ? { x: clickEv.x, y: clickEv.y } : void 0;
    const eventIndices = cluster.map((e) => e.eventIndex);
    stepsWithoutNumber.push({
      primaryAction: primaryActionType,
      target,
      timestamp: midTs,
      frameId,
      position,
      eventIndices
    });
    clusterList.push(cluster);
  }
  const merged = mergeMicroSteps(stepsWithoutNumber, clusterList);
  return merged.map((s, i) => ({
    ...s,
    stepNumber: i + 1
  }));
}
function inferIntentFallback(primaryAction2, target) {
  const t = (target ?? "").toLowerCase();
  if (primaryAction2 === "click") {
    if (/\b(save|submit|confirm|done)\b/.test(t)) return "submit";
    if (/\b(dropdown|select|choose|menu)\b/.test(t) || t.includes("select")) return "select";
    return "click";
  }
  if (primaryAction2 === "key") return "input";
  if (primaryAction2 === "focus") return "navigate";
  return "other";
}
function templateTitle(primaryAction2, target) {
  if (target) {
    const clean = target.replace(/\s+/g, " ").trim().slice(0, 50);
    if (primaryAction2 === "click") return `Click ${clean}`;
    if (primaryAction2 === "key") return clean ? `Enter ${clean}` : "Enter details";
    if (primaryAction2 === "focus") return clean ? `Open ${clean}` : "Navigate";
  }
  if (primaryAction2 === "click") return "Click";
  if (primaryAction2 === "key") return "Enter details";
  if (primaryAction2 === "focus") return "Navigate";
  return "Continue";
}
function toExtractedStepsWithTemplates(rawSteps) {
  return rawSteps.map((r) => ({
    stepNumber: r.stepNumber,
    action: inferIntentFallback(r.primaryAction, r.target),
    title: templateTitle(r.primaryAction, r.target),
    target: r.target,
    timestamp: r.timestamp,
    frameId: r.frameId,
    position: r.position,
    eventIndices: r.eventIndices
  }));
}
function extractSteps(events) {
  return toExtractedStepsWithTemplates(extractRawSteps(events));
}
function formatStepsForPayload(steps) {
  if (steps.length === 0) return "";
  return steps.map((s) => `Step ${s.stepNumber}: ${s.title}${s.target ? ` (${s.target})` : ""}`).join("\n");
}

// src/enrich-steps.ts
var ENRICH_MODEL = "gpt-4o-mini";
var VALID_ACTIONS = ["click", "input", "navigate", "submit", "select", "other"];
function parseEnrichResponse(text, rawSteps) {
  const steps = [];
  let missingSteps;
  try {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const json = JSON.parse(cleaned);
    const raw = json.steps ?? [];
    for (const r of rawSteps) {
      const fromLlm = raw.find((s) => s.stepNumber === r.stepNumber);
      const action = fromLlm?.intent && VALID_ACTIONS.includes(fromLlm.intent) ? fromLlm.intent : "other";
      steps.push({
        stepNumber: r.stepNumber,
        action,
        title: fromLlm?.title?.trim() ?? `Step ${r.stepNumber}`,
        description: fromLlm?.description?.trim(),
        target: fromLlm?.target ?? r.target,
        timestamp: r.timestamp,
        frameId: r.frameId,
        position: r.position,
        eventIndices: r.eventIndices
      });
    }
    if (Array.isArray(json.missingSteps) && json.missingSteps.length > 0) {
      missingSteps = json.missingSteps.filter((m) => m.afterStepNumber != null && m.title).map((m) => ({
        afterStepNumber: Number(m.afterStepNumber),
        title: String(m.title).trim(),
        description: m.description?.trim()
      }));
    }
  } catch {
    for (const r of rawSteps) {
      steps.push({
        stepNumber: r.stepNumber,
        action: "other",
        title: `Step ${r.stepNumber}`,
        target: r.target,
        timestamp: r.timestamp,
        frameId: r.frameId,
        position: r.position,
        eventIndices: r.eventIndices
      });
    }
  }
  return { steps, missingSteps };
}
async function enrichStepsWithLLM(client, rawSteps, context, options) {
  if (rawSteps.length === 0) return { steps: [] };
  const productName = context.productName;
  const narration = context.narration ?? "";
  const traceSnippet = context.traceSnippet ?? "";
  const stepsJson = JSON.stringify(
    rawSteps.map((s) => ({
      stepNumber: s.stepNumber,
      primaryAction: s.primaryAction,
      target: s.target,
      timestamp: new Date(s.timestamp).toISOString()
    })),
    null,
    2
  );
  const systemPrompt = `You are a technical writer. You receive deterministic workflow steps (primaryAction, target, timestamp) from a session. Your job is ONLY to:
1. **Step naming**: Give each step a short, action-oriented title (e.g. "Click + Ticket", "Enter ticket details", "Open Tickets").
2. **Intent inference**: Set intent to one of: click | input | navigate | submit | select | other.
3. **Missing step detection**: If the flow clearly implies a step that is not in the list (e.g. user opened a page before the first click), add it to missingSteps with afterStepNumber (0 = before step 1), title, and optional description.
4. **Description**: One short sentence per step explaining what the user does or why it matters.

Output valid JSON only, no markdown. Schema:
{
  "steps": [ { "stepNumber": number, "title": string, "intent": "click"|"input"|"navigate"|"submit"|"select"|"other", "description": string (optional), "target": string (optional) } ],
  "missingSteps": [ { "afterStepNumber": number, "title": string, "description": string (optional) } ]  // optional
}
Preserve stepNumber order. Include every step from the input.`;
  const userPrompt = `Product: ${productName}

Raw steps (deterministic; do not change order or add steps to this array\u2014only add implied steps in missingSteps):
${stepsJson}
${narration ? `
Narration from the user (use for naming and intent):
"${narration.slice(0, 1500)}"
` : ""}
${traceSnippet ? `
Trace snippet (for context):
${traceSnippet.slice(0, 1500)}
` : ""}

Output JSON with "steps" (one object per raw step with title, intent, description, optional target) and optionally "missingSteps".`;
  const model = options?.model ?? process.env.DOC_FROM_USAGE_ENRICH_MODEL ?? ENRICH_MODEL;
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_completion_tokens: 2048
  });
  const content = response.choices[0]?.message?.content?.trim();
  if (!content) return { steps: rawSteps.map((r) => ({ stepNumber: r.stepNumber, action: "other", title: `Step ${r.stepNumber}`, target: r.target, timestamp: r.timestamp, frameId: r.frameId, position: r.position, eventIndices: r.eventIndices })) };
  return parseEnrichResponse(content, rawSteps);
}

// src/generate-docs.ts
var DEFAULT_MODEL = "gpt-5.2";
var MAX_OCR_TEXT_PER_SCREEN = 600;
function isDocFromUsageEvent(e) {
  const win = (e.windowName ?? "").toLowerCase();
  const url = (e.url ?? "").toLowerCase();
  if (win.includes("doc from usage") || url.includes("localhost:3040")) return true;
  return false;
}
function optimizeTraceEvents(events) {
  const out = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];
    if (e.type === "audio") {
      out.push(e);
      i++;
      continue;
    }
    if (isDocFromUsageEvent(e)) {
      i++;
      continue;
    }
    if (e.type === "input") {
      const et = (e.eventType ?? "").toLowerCase();
      if (et === "scroll") {
        i++;
        continue;
      }
      if (et === "window_focus" || et === "app_switch") {
        i++;
        continue;
      }
      if (et === "click") {
        const windowKey = `${e.appName ?? ""}|${e.windowName ?? ""}`;
        const t = new Date(e.timestamp).getTime();
        let j = i + 1;
        while (j < events.length) {
          const next = events[j];
          if (next.type !== "input" || (next.eventType ?? "").toLowerCase() !== "click") break;
          if (isDocFromUsageEvent(next)) break;
          const nextWindow = `${next.appName ?? ""}|${next.windowName ?? ""}`;
          const nextT = new Date(next.timestamp).getTime();
          if (nextWindow !== windowKey || nextT - t > 500) break;
          j++;
        }
        out.push(e);
        i = j;
        continue;
      }
    }
    if (e.type === "ocr") {
      const truncated = { ...e };
      if (e.text && e.text.length > MAX_OCR_TEXT_PER_SCREEN) {
        truncated.text = e.text.slice(0, MAX_OCR_TEXT_PER_SCREEN) + "\n\u2026 [truncated]";
      }
      out.push(truncated);
      i++;
      continue;
    }
    out.push(e);
    i++;
  }
  return out;
}
function buildTraceText(events) {
  const lines = [];
  for (const e of events) {
    const time = new Date(e.timestamp).toISOString();
    if (e.type === "ocr") {
      lines.push(`[${time}] [screen] ${e.appName || ""} | ${e.windowName || ""} ${e.url ? `| ${e.url}` : ""}`);
      if (e.text) lines.push(e.text);
    } else if (e.type === "audio") {
      lines.push(`[${time}] [speech] ${e.text ?? ""}`);
    } else {
      lines.push(`[${time}] [${e.eventType || "action"}] ${e.appName || ""} | ${e.windowName || ""} ${e.text ? `| "${e.text}"` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
function buildRawTracePayload(options) {
  const optimized = optimizeTraceEvents(options.events);
  const trace = buildTraceText(optimized);
  const speechEvents = optimized.filter((e) => e.type === "audio" && (e.text ?? "").trim());
  const narrationBlock = speechEvents.length > 0 ? `

Narration (what the user said while recording \u2014 use this in the doc):
${speechEvents.map((e) => `- "${(e.text ?? "").trim()}"`).join("\n")}` : "";
  const screenshotBlock = options.screenshotContexts && options.screenshotContexts.length > 0 ? `

Screenshots to embed in the doc (place each in the section/step that matches its context; use ![description](images/screen-K.png) with K = 1, 2, \u2026):
${options.screenshotContexts.map((c, i) => `- ${c} \u2192 use images/screen-${i + 1}.png`).join("\n")}` : "";
  const steps = options.steps ?? extractSteps(optimized);
  const stepsBlock = steps.length > 0 ? `

Extracted steps (use to structure the doc; align sections with these):
${formatStepsForPayload(steps)}` : "";
  const missingBlock = options.missingSteps && options.missingSteps.length > 0 ? `

Suggested missing steps (insert after the step number if they fit the flow):
${options.missingSteps.map((m) => `- After step ${m.afterStepNumber}: ${m.title}${m.description ? ` \u2014 ${m.description}` : ""}`).join("\n")}` : "";
  return `Product name: ${options.productName}

Usage trace (chronological):

${trace || "(no events)"}${narrationBlock}${stepsBlock}${missingBlock}${screenshotBlock}`;
}
var SYSTEM_PROMPT = `You are an expert SaaS technical writer.

Your job is to convert a raw product usage trace into a clear help center article.

Follow documentation quality similar to:

- Intercom Help Center
- Stripe Dashboard guides
- Notion tutorials
- Slack help articles

STYLE RULES:

- Clear and friendly tone
- Action-oriented instructions
- Short sentences
- Bold UI labels
- One action per step
- Screenshot after each step
- Do NOT mention recording or traces
- Infer missing context intelligently

STRUCTURE:

# Title

Short intro explaining what the user will accomplish.

---

## Step 1: <action title>

Instruction.

![Screenshot](image)

---

## Step N

Instruction.

---

\u{1F4A1} Tips (optional)

\u26A0\uFE0F Warnings (optional)

---

IMPORTANT INTERPRETATION RULES:

1. Use narration to understand intent.
2. Use OCR text to identify UI labels.
3. Ignore noise events (scroll spam, duplicate clicks).
4. Merge rapid clicks into a single step.
5. Prefer semantic meaning over raw logs.
6. Assume the user is successful unless proven otherwise.
7. If UI text is partially visible, infer the most likely label.

OUTPUT FORMAT:

Markdown only.

Below is an example:

# Create a Ticket in DevRev

Learn how to quickly create a new support ticket in DevRev using the Tickets workspace.

---

## Step 1: Open the Tickets workspace

Navigate to the **Tickets** section from the main navigation menu.

![Tickets workspace](images/screen-1.png)

---

## Step 2: Click **+ Ticket**

Click the **+ Ticket** button to start creating a new ticket.

![Create ticket button](images/screen-2.png)

---

## Step 3: Choose how you want to create the ticket

You can either:

* Select a template, or
* Create a ticket from scratch

Choose the option that best fits your workflow.

![Ticket creation options](images/screen-3.png)

---

## Step 4: Enter ticket details

Fill in the required fields such as title, owner, account, and any additional information needed for the ticket.

![Ticket details form](images/screen-4.png)

---

## Step 5: Click **Create**

Once all details are complete, click **Create** to save the ticket.

---

\u{1F4A1} Tip
Using templates can help standardize ticket creation and save time for common workflows.

---

INPUT: You will receive a message containing: (1) Product name, (2) Usage trace (chronological) with lines tagged [screen], [speech], or [action], (3) Narration (if any), (4) Extracted steps (suggested step structure\u2014align your sections with these when present), (5) Screenshots to embed with context. Use the trace, narration, and extracted steps to build the article. Prefer the extracted step titles when they match the flow. Embed each screenshot in the step it matches using ![description](images/screen-K.png) with K = 1, 2, 3, \u2026; use .png in the path. Place each image right after the step it illustrates.`;
async function generateDocumentation(options) {
  const apiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OpenAI API key not set. Set OPENAI_API_KEY or save your token in the Doc-from-Usage UI (http://localhost:3040)."
    );
  }
  const client = new OpenAI({
    apiKey,
    baseURL: options.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? void 0
  });
  const optimized = optimizeTraceEvents(options.events);
  const rawSteps = extractRawSteps(optimized);
  const narration = optimized.filter((e) => e.type === "audio" && (e.text ?? "").trim()).map((e) => (e.text ?? "").trim()).join(" ");
  const traceSnippet = buildTraceText(optimized).slice(0, 1500);
  let steps = [];
  let missingSteps;
  if (rawSteps.length > 0) {
    const enriched = await enrichStepsWithLLM(client, rawSteps, {
      productName: options.productName,
      narration: narration || void 0,
      traceSnippet: traceSnippet || void 0
    }).catch(() => ({ steps: toExtractedStepsWithTemplates(rawSteps), missingSteps: void 0 }));
    steps = enriched.steps;
    missingSteps = enriched.missingSteps;
  }
  const userMessage = buildRawTracePayload({
    events: options.events,
    productName: options.productName,
    screenshotContexts: options.screenshotContexts,
    steps: steps.length > 0 ? steps : void 0,
    missingSteps
  });
  const model = options.model ?? process.env.DOC_FROM_USAGE_MODEL ?? DEFAULT_MODEL;
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage }
    ],
    max_completion_tokens: 4096
  });
  let content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned no content");
  }
  const trimmed = content.trim();
  if (trimmed.startsWith("```markdown") && trimmed.endsWith("```")) {
    content = trimmed.slice(11, trimmed.length - 3).trimStart();
  } else if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    content = trimmed.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trimStart();
  }
  return content;
}

// src/config.ts
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
var CONFIG_DIR = process.env.DOC_FROM_USAGE_CONFIG_DIR ?? join(homedir(), ".doc-from-usage");
var CONFIG_FILE = join(CONFIG_DIR, "config.json");
var cached = null;
async function loadConfig() {
  if (cached) return cached;
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    cached = JSON.parse(raw);
    return cached ?? {};
  } catch {
    cached = {};
    return {};
  }
}
async function saveConfig(updates) {
  const current = await loadConfig();
  const next = { ...current, ...updates };
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  cached = next;
  return next;
}
async function getOpenAiApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const config = await loadConfig();
  return config.openaiApiKey;
}
async function getDeepgramApiKey() {
  if (process.env.DEEPGRAM_API_KEY) return process.env.DEEPGRAM_API_KEY;
  const config = await loadConfig();
  return config.deepgramApiKey;
}

// src/write-docs.ts
import { writeFile as writeFile2, mkdir as mkdir2, readFile as readFile2 } from "fs/promises";
import { join as join2 } from "path";
var SCREENPIPE_API = process.env.SCREENPIPE_API ?? "http://localhost:3030";
var MAX_SCREENSHOTS = 100;
function expandPath(p) {
  if (p.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return home ? join2(home, p.slice(1)) : p;
  }
  return p;
}
function nearestOcrFrameId(events, timeMs) {
  let best = null;
  for (const e of events) {
    if (e.type !== "ocr" || e.frameId == null) continue;
    const delta = Math.abs(new Date(e.timestamp).getTime() - timeMs);
    if (best == null || delta < best.delta) best = { frameId: e.frameId, delta };
  }
  return best?.frameId ?? null;
}
var SCREENSHOT_SHORTCUT_KEY_CODES = [46, 77];
var SCREENSHOT_SHORTCUT_MODIFIER_CMD = 8;
function isScreenshotShortcut(e) {
  if (e.type !== "input" || (e.eventType?.toLowerCase() ?? "") !== "key") return false;
  const keyCode = e.keyCode;
  const mods = e.modifiers ?? 0;
  return keyCode != null && SCREENSHOT_SHORTCUT_KEY_CODES.includes(keyCode) && (mods & SCREENSHOT_SHORTCUT_MODIFIER_CMD) !== 0;
}
function pickKeyFrameIdsWithTimestamps(events) {
  const frameIds = [];
  const timestamps = [];
  const actionEvents = events.filter((e) => e.type === "input" && isScreenshotShortcut(e));
  for (const e of actionEvents) {
    if (frameIds.length >= MAX_SCREENSHOTS) break;
    const timeMs = new Date(e.timestamp).getTime();
    const frameId = nearestOcrFrameId(events, timeMs);
    if (frameId != null) {
      frameIds.push(frameId);
      timestamps.push(timeMs);
    }
  }
  if (frameIds.length === 0) {
    const ocrWithFrame = events.filter((e) => e.type === "ocr" && e.frameId != null);
    const byTime = [...ocrWithFrame].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const seen = /* @__PURE__ */ new Set();
    const uniqueByTime = [];
    for (const e of byTime) {
      if (seen.has(e.frameId)) continue;
      seen.add(e.frameId);
      uniqueByTime.push(e.frameId);
    }
    if (uniqueByTime.length === 0) return { frameIds, timestamps };
    const n = Math.min(MAX_SCREENSHOTS, uniqueByTime.length);
    for (let i = 0; i < n; i++) {
      const idx = n === 1 ? 0 : Math.round(i / (n - 1) * (uniqueByTime.length - 1));
      frameIds.push(uniqueByTime[idx]);
      const ocrAt = byTime.find((x) => x.frameId === uniqueByTime[idx]);
      timestamps.push(ocrAt ? new Date(ocrAt.timestamp).getTime() : 0);
    }
  }
  return { frameIds, timestamps };
}
function pickKeyFrameIds(events) {
  return pickKeyFrameIdsWithTimestamps(events).frameIds;
}
function nearestSpeechBefore(events, timeMs) {
  let best = null;
  for (const e of events) {
    if (e.type !== "audio" || !(e.text ?? "").trim()) continue;
    const t = new Date(e.timestamp).getTime();
    if (t > timeMs + 5e3) continue;
    const delta = timeMs - t;
    if (delta < 0) continue;
    if (best == null || delta < best.delta) best = { text: (e.text ?? "").trim().slice(0, 120), delta };
  }
  return best?.text ?? null;
}
function getScreenshotContexts(events) {
  const { frameIds, timestamps } = pickKeyFrameIdsWithTimestamps(events);
  const contexts = [];
  for (let i = 0; i < frameIds.length; i++) {
    const t = timestamps[i];
    const speech = nearestSpeechBefore(events, t);
    const timeStr = new Date(t).toISOString().slice(11, 19);
    if (speech) {
      contexts.push(`Screenshot ${i + 1} (${timeStr}): After narration: "${speech}${speech.length >= 120 ? "\u2026" : ""}"`);
    } else {
      contexts.push(`Screenshot ${i + 1} (${timeStr}): Captured at this point in the session`);
    }
  }
  return { frameIds, contexts };
}
async function getFrameBuffer(frameId, frameBase64ById, baseUrl) {
  const inline = frameBase64ById.get(frameId);
  if (inline) return Buffer.from(inline, "base64");
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/frames/${frameId}`);
  if (!res.ok) throw new Error(`Failed to fetch frame ${frameId}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
async function saveFrameBuffer(buf, index, imagesDir) {
  const ext = buf[0] === 255 && buf[1] === 216 ? "jpg" : "png";
  const filename = `screen-${index + 1}.${ext}`;
  const filePath = join2(imagesDir, filename);
  await writeFile2(filePath, buf);
  return `images/${filename}`;
}
async function writeDocsToFolder(options) {
  const folder = expandPath(options.outputFolder);
  const imagesDir = join2(folder, "images");
  await mkdir2(imagesDir, { recursive: true });
  const baseUrl = options.baseUrl ?? SCREENPIPE_API;
  const frameIds = pickKeyFrameIds(options.events);
  const frameBase64ById = /* @__PURE__ */ new Map();
  for (const e of options.events) {
    if (e.type === "ocr" && e.frameId != null && e.frameBase64) {
      frameBase64ById.set(e.frameId, e.frameBase64);
    }
  }
  const imagePaths = [];
  let failedFrames = 0;
  for (let i = 0; i < frameIds.length; i++) {
    try {
      const buf = await getFrameBuffer(frameIds[i], frameBase64ById, baseUrl);
      const rel = await saveFrameBuffer(buf, imagePaths.length, imagesDir);
      imagePaths.push(rel);
    } catch {
      failedFrames++;
    }
  }
  let body = options.markdownBody;
  for (let i = 0; i < imagePaths.length; i++) {
    const k = i + 1;
    body = body.replace(new RegExp(`images/screen-${k}\\.png`, "g"), imagePaths[i]);
    body = body.replace(new RegExp(`images/screen-${k}\\.jpg`, "g"), imagePaths[i]);
  }
  if (imagePaths.length > 0 && !/images\/screen-\d+\.(png|jpg)/.test(body)) {
    body += `

---

## Screenshots

`;
    imagePaths.forEach((rel, i) => {
      body += `
![Screen ${i + 1}](${rel})

`;
    });
  }
  const title = `# ${options.productName} \u2013 Documentation (generated from usage)

`;
  const subtitle = `*Generated from Screenpipe usage between ${options.startTime} and ${options.endTime}.*

---

`;
  let fullMarkdown = title + subtitle + body;
  const safeName = options.productName.replace(/[^a-zA-Z0-9-_]/g, "-");
  const dateStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  if (failedFrames > 0 && imagePaths.length === 0) {
    fullMarkdown += `

---
*Screenshot images could not be loaded (${failedFrames} frame(s) unavailable). Keep Screenpipe running when you Download, or try again soon after recording.*`;
  }
  if (options.outputFormat === "docx") {
    const docxPath = join2(folder, `${safeName}-${dateStr}.docx`);
    const docxBuf = await markdownToDocx(fullMarkdown, folder);
    await writeFile2(docxPath, docxBuf);
    return { path: docxPath, imagesCount: imagePaths.length, framesFailed: failedFrames > 0 ? failedFrames : void 0 };
  }
  const mdPath = join2(folder, `${safeName}-${dateStr}.md`);
  await writeFile2(mdPath, fullMarkdown, "utf-8");
  return { path: mdPath, imagesCount: imagePaths.length, framesFailed: failedFrames > 0 ? failedFrames : void 0 };
}
async function markdownToDocx(markdown, baseDir) {
  const docx = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun } = docx;
  const lines = markdown.split(/\r?\n/);
  const children = [];
  const imageDir = join2(baseDir, "images");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      children.push(new Paragraph({ text: "" }));
      continue;
    }
    if (trimmed.startsWith("# ")) {
      children.push(new Paragraph({ text: trimmed.slice(2), heading: HeadingLevel.TITLE }));
      continue;
    }
    if (trimmed.startsWith("## ")) {
      children.push(new Paragraph({ text: trimmed.slice(3), heading: HeadingLevel.HEADING_1 }));
      continue;
    }
    if (trimmed.startsWith("### ")) {
      children.push(new Paragraph({ text: trimmed.slice(4), heading: HeadingLevel.HEADING_2 }));
      continue;
    }
    const imgMatch = trimmed.match(/!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      const relPath = imgMatch[2];
      const absPath = relPath.startsWith("images/") ? join2(baseDir, relPath) : join2(imageDir, relPath);
      try {
        const buf = await readFile2(absPath);
        const ext = absPath.toLowerCase().endsWith(".png") ? "png" : "jpg";
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                data: buf,
                type: ext,
                transformation: { width: 480, height: 300 }
              })
            ]
          })
        );
      } catch {
        children.push(new Paragraph({ children: [new TextRun(trimmed)] }));
      }
      continue;
    }
    const boldRegex = /\*\*([^*]+)\*\*/g;
    const runs = [];
    let lastIndex = 0;
    let m;
    while ((m = boldRegex.exec(trimmed)) !== null) {
      if (m.index > lastIndex) {
        runs.push(new TextRun(trimmed.slice(lastIndex, m.index)));
      }
      runs.push(new TextRun({ text: m[1], bold: true }));
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < trimmed.length) runs.push(new TextRun(trimmed.slice(lastIndex)));
    children.push(new Paragraph({ children: runs.length ? runs : [new TextRun(trimmed)] }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export {
  fetchUsageEvents,
  buildRawTracePayload,
  generateDocumentation,
  loadConfig,
  saveConfig,
  getOpenAiApiKey,
  getDeepgramApiKey,
  getScreenshotContexts,
  writeDocsToFolder
};
