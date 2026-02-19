/**
 * Production-grade step extraction from usage events.
 * DETERMINISTIC ONLY: normalize → noise filter → temporal clustering → primary action → target label → merge micro-steps → attach frame.
 * No LLM here. Use enrichStepsWithLLM() for: step naming, intent inference, missing step detection, descriptions.
 */

import type { UsageEvent } from "./types.js";

/** Normalized event schema for pipeline (timestamps in ms, trimmed text, lowercase comparisons). */
export interface NormalizedEvent {
  timestamp: number;
  type: "click" | "key" | "screen" | "focus" | "scroll" | "speech";
  app: string;
  window: string;
  url?: string;
  text?: string;
  elementName?: string;
  x?: number;
  y?: number;
  /** Original OCR text (for screen); kept for label extraction. */
  ocrText?: string;
  /** Original event index in the events array (for frameId lookup). */
  eventIndex: number;
}

/** Raw step from deterministic pipeline only (no naming, intent, or description). */
export interface RawExtractedStep {
  stepNumber: number;
  /** Primary interaction in cluster: click | key | focus | screen. */
  primaryAction: "click" | "key" | "focus" | "screen";
  target?: string;
  timestamp: number;
  frameId?: number;
  position?: { x: number; y: number };
  eventIndices?: number[];
}

/** Enriched step for documentation (adds LLM output: title, intent, description). */
export interface ExtractedStep {
  stepNumber: number;
  action: "click" | "input" | "navigate" | "submit" | "select" | "other";
  title: string;
  description?: string;
  target?: string;
  timestamp: number;
  frameId?: number;
  position?: { x: number; y: number };
  eventIndices?: number[];
}

const CLUSTER_WINDOW_MS = 3000;
const DUPLICATE_CLICK_MS = 300;
const SAME_SCREEN_OCR_MS = 2000;
const MERGE_MICRO_STEP_MS = 5000;
const MAX_OCR_FOR_LABEL = 400;

/** Documate recorder UI: exclude from product steps. */
function isDocFromUsage(e: { window?: string; url?: string }): boolean {
  const w = (e.window ?? "").toLowerCase();
  const u = (e.url ?? "").toLowerCase();
  return w.includes("documate") || w.includes("doc from usage") || u.includes("localhost:3040");
}

/** Step 1 — Normalize UsageEvent[] to NormalizedEvent[]. */
function normalizeEvents(events: UsageEvent[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const ts = new Date(e.timestamp).getTime();
    const app = (e.appName ?? "").trim();
    const window = (e.windowName ?? "").trim();
    const url = (e.url ?? "").trim();
    const text = (e.text ?? "").trim().toLowerCase();
    const ocrText = e.type === "ocr" ? (e.text ?? "").trim() : undefined;

    if (e.type === "ocr") {
      out.push({
        timestamp: ts,
        type: "screen",
        app,
        window,
        url: url || undefined,
        ocrText: ocrText || undefined,
        text: text.slice(0, MAX_OCR_FOR_LABEL) || undefined,
        eventIndex: i,
      });
      continue;
    }
    if (e.type === "audio") {
      out.push({
        timestamp: ts,
        type: "speech",
        app,
        window,
        text: (e.text ?? "").trim() || undefined,
        eventIndex: i,
      });
      continue;
    }
    // input
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
        url: url || undefined,
        eventIndex: i,
      });
      continue;
    }
    if (et === "click") {
      out.push({
        timestamp: ts,
        type: "click",
        app,
        window,
        url: url || undefined,
        elementName: (e.elementName ?? e.text ?? "").trim() || undefined,
        x: e.x,
        y: e.y,
        eventIndex: i,
      });
      continue;
    }
    // key / text input
    out.push({
      timestamp: ts,
      type: "key",
      app,
      window,
      url: url || undefined,
      text: (e.text ?? "").trim() || undefined,
      eventIndex: i,
    });
  }
  return out;
}

/** Step 2 — Noise filtering: drop scroll, duplicate clicks (<300ms), repeated same screen OCR. */
function filterNoise(normalized: NormalizedEvent[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  let lastScreenText: string | null = null;
  let lastScreenTs = 0;
  let lastClickKey: string | null = null;
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
    // focus, key
    out.push(e);
  }
  return out;
}

/** Step 3 — Temporal clustering: group events within CLUSTER_WINDOW_MS (anchors: click, key with text, focus, URL/window change, speech). */
function clusterByTime(events: NormalizedEvent[]): NormalizedEvent[][] {
  const clusters: NormalizedEvent[][] = [];
  let current: NormalizedEvent[] = [];
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

/** Step 4 — Primary action in cluster: click > key > focus/navigate > screen. */
function primaryAction(cluster: NormalizedEvent[]): "click" | "key" | "focus" | "screen" {
  const hasClick = cluster.some((e) => e.type === "click");
  if (hasClick) return "click";
  const hasKey = cluster.some((e) => e.type === "key" && (e.text ?? "").length > 0);
  if (hasKey) return "key";
  const hasFocus = cluster.some((e) => e.type === "focus");
  if (hasFocus) return "focus";
  return "screen";
}

/** Step 5 — Target label: elementName > OCR near click > speech > URL/window. */
function extractTargetLabel(
  cluster: NormalizedEvent[],
  action: "click" | "key" | "focus" | "screen",
  events: UsageEvent[]
): string | undefined {
  // Priority 1: elementName from click
  const clickEv = cluster.find((e) => e.type === "click");
  if (clickEv?.elementName) return clickEv.elementName.trim();

  // Priority 2: OCR near click (same cluster or recent screen)
  if (clickEv && (clickEv.x != null || clickEv.y != null)) {
    const screenInCluster = cluster.filter((e) => e.type === "screen");
    const best = screenInCluster[screenInCluster.length - 1];
    if (best?.ocrText) {
      const snippet = best.ocrText.slice(0, 200).replace(/\s+/g, " ").trim();
      if (snippet) return snippet;
    }
  }

  // Priority 3: Speech in or just before cluster
  const speech = cluster.find((e) => e.type === "speech");
  if (speech?.text) return speech.text.slice(0, 80).trim();

  // Priority 4: URL / window
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

  // Key: use typed text as target
  if (action === "key") {
    const keyEv = cluster.find((e) => e.type === "key" && e.text);
    if (keyEv?.text) return keyEv.text.slice(0, 60);
  }

  return undefined;
}

/** Closest OCR frame to a timestamp from original events. */
function closestFrameId(events: UsageEvent[], timeMs: number): number | undefined {
  let best: { frameId: number; delta: number } | null = null;
  for (const e of events) {
    if (e.type !== "ocr" || e.frameId == null) continue;
    const delta = Math.abs(new Date(e.timestamp).getTime() - timeMs);
    if (best == null || delta < best.delta) best = { frameId: e.frameId, delta };
  }
  return best?.frameId;
}

/** Merge micro-steps: click + key within 5s same window → single raw step (key). */
function mergeMicroSteps(
  steps: Omit<RawExtractedStep, "stepNumber">[],
  clusterEvents: NormalizedEvent[][]
): Omit<RawExtractedStep, "stepNumber">[] {
  const merged: Omit<RawExtractedStep, "stepNumber">[] = [];
  let i = 0;
  while (i < steps.length) {
    const cur = steps[i];
    const curCluster = clusterEvents[i];
    const curMid = curCluster.length ? curCluster.reduce((s, e) => s + e.timestamp, 0) / curCluster.length : cur.timestamp;

    if (cur.primaryAction === "click" && i + 1 < steps.length) {
      const next = steps[i + 1];
      const nextCluster = clusterEvents[i + 1];
      const nextMid =
        nextCluster.length ? nextCluster.reduce((s, e) => s + e.timestamp, 0) / nextCluster.length : next.timestamp;
      if (
        next.primaryAction === "key" &&
        nextMid - curMid <= MERGE_MICRO_STEP_MS &&
        curCluster[0]?.window === nextCluster[0]?.window
      ) {
        merged.push({
          primaryAction: "key",
          target: next.target ?? "details",
          timestamp: cur.timestamp,
          frameId: cur.frameId ?? next.frameId,
          position: cur.position ?? next.position,
          eventIndices: [...(cur.eventIndices ?? []), ...(next.eventIndices ?? [])],
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

/**
 * Deterministic pipeline only: normalize → filter → cluster → primary action → target label → merge → frameId.
 * Returns raw steps (no title, intent, or description). Use enrichStepsWithLLM() for those.
 */
export function extractRawSteps(events: UsageEvent[]): RawExtractedStep[] {
  if (events.length === 0) return [];

  const normalized = normalizeEvents(events);
  const filtered = filterNoise(normalized).filter((e) => !isDocFromUsage(e));
  if (filtered.length === 0) return [];

  const clusters = clusterByTime(filtered);
  const stepsWithoutNumber: Omit<RawExtractedStep, "stepNumber">[] = [];
  const clusterList: NormalizedEvent[][] = [];

  for (const cluster of clusters) {
    const primaryActionType = primaryAction(cluster);
    if (primaryActionType === "screen" && cluster.every((e) => e.type === "screen")) continue;
    const target = extractTargetLabel(cluster, primaryActionType, events);
    const midTs =
      cluster.length > 0 ? cluster.reduce((s, e) => s + e.timestamp, 0) / cluster.length : cluster[0]?.timestamp ?? 0;
    const frameId = closestFrameId(events, midTs);
    const clickEv = cluster.find((e) => e.type === "click");
    const position =
      clickEv && clickEv.x != null && clickEv.y != null ? { x: clickEv.x, y: clickEv.y } : undefined;
    const eventIndices = cluster.map((e) => e.eventIndex);

    stepsWithoutNumber.push({
      primaryAction: primaryActionType,
      target,
      timestamp: midTs,
      frameId,
      position,
      eventIndices,
    });
    clusterList.push(cluster);
  }

  const merged = mergeMicroSteps(stepsWithoutNumber, clusterList);
  return merged.map((s, i) => ({
    ...s,
    stepNumber: i + 1,
  }));
}

/** Rule-based intent (fallback when LLM is not used). */
function inferIntentFallback(primaryAction: RawExtractedStep["primaryAction"], target: string | undefined): ExtractedStep["action"] {
  const t = (target ?? "").toLowerCase();
  if (primaryAction === "click") {
    if (/\b(save|submit|confirm|done)\b/.test(t)) return "submit";
    if (/\b(dropdown|select|choose|menu)\b/.test(t) || t.includes("select")) return "select";
    return "click";
  }
  if (primaryAction === "key") return "input";
  if (primaryAction === "focus") return "navigate";
  return "other";
}

/** Template title (fallback when LLM is not used). */
function templateTitle(primaryAction: RawExtractedStep["primaryAction"], target: string | undefined): string {
  if (target) {
    const clean = target.replace(/\s+/g, " ").trim().slice(0, 50);
    if (primaryAction === "click") return `Click ${clean}`;
    if (primaryAction === "key") return clean ? `Enter ${clean}` : "Enter details";
    if (primaryAction === "focus") return clean ? `Open ${clean}` : "Navigate";
  }
  if (primaryAction === "click") return "Click";
  if (primaryAction === "key") return "Enter details";
  if (primaryAction === "focus") return "Navigate";
  return "Continue";
}

/** Convert raw steps to ExtractedStep with template titles and rule-based intent (no LLM). */
export function toExtractedStepsWithTemplates(rawSteps: RawExtractedStep[]): ExtractedStep[] {
  return rawSteps.map((r) => ({
    stepNumber: r.stepNumber,
    action: inferIntentFallback(r.primaryAction, r.target),
    title: templateTitle(r.primaryAction, r.target),
    target: r.target,
    timestamp: r.timestamp,
    frameId: r.frameId,
    position: r.position,
    eventIndices: r.eventIndices,
  }));
}

/** Extract steps with template fallback only (no LLM). Use when enrichment is skipped. */
export function extractSteps(events: UsageEvent[]): ExtractedStep[] {
  return toExtractedStepsWithTemplates(extractRawSteps(events));
}

/** Format extracted steps as a short bullet list for inclusion in the LLM payload. */
export function formatStepsForPayload(steps: ExtractedStep[]): string {
  if (steps.length === 0) return "";
  return steps.map((s) => `Step ${s.stepNumber}: ${s.title}${s.target ? ` (${s.target})` : ""}`).join("\n");
}
