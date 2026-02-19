/**
 * Write documentation to a folder: markdown + images subfolder, or single .docx with images.
 */

import { writeFile, mkdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import type { UsageEvent } from "./types.js";

const SCREENPIPE_API = process.env.SCREENPIPE_API ?? "http://localhost:3030";
const MAX_SCREENSHOTS = 100; // one per click, capped
const MIN_INTERVAL_MS = 1500; // fallback: one every 1.5s when no clicks (so short sessions get several images)

function expandPath(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return home ? join(home, p.slice(1)) : p;
  }
  return p;
}

/** Find the OCR event with the closest timestamp to the given time (and with a frameId). */
function nearestOcrFrameId(events: UsageEvent[], timeMs: number): number | null {
  let best: { frameId: number; delta: number } | null = null;
  for (const e of events) {
    if (e.type !== "ocr" || e.frameId == null) continue;
    const delta = Math.abs(new Date(e.timestamp).getTime() - timeMs);
    if (best == null || delta < best.delta) best = { frameId: e.frameId, delta };
  }
  return best?.frameId ?? null;
}

/** Cmd+M (macOS) or Win+M (Windows): dedicated "screenshot now" shortcut. Key codes: 46 = M (macOS), 77 = M (Windows). Modifier 8 = Cmd/Win. */
const SCREENSHOT_SHORTCUT_KEY_CODES = [46, 77];
const SCREENSHOT_SHORTCUT_MODIFIER_CMD = 8;

function isScreenshotShortcut(e: UsageEvent): boolean {
  if (e.type !== "input" || (e.eventType?.toLowerCase() ?? "") !== "key") return false;
  const keyCode = e.keyCode;
  const mods = e.modifiers ?? 0;
  return (
    keyCode != null &&
    SCREENSHOT_SHORTCUT_KEY_CODES.includes(keyCode) &&
    (mods & SCREENSHOT_SHORTCUT_MODIFIER_CMD) !== 0
  );
}

/** Pair of frame ID and timestamp (ms) for building contexts. */
function pickKeyFrameIdsWithTimestamps(events: UsageEvent[]): { frameIds: number[]; timestamps: number[] } {
  const frameIds: number[] = [];
  const timestamps: number[] = [];
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
    const ocrWithFrame = events.filter((e) => e.type === "ocr" && e.frameId != null) as Array<UsageEvent & { frameId: number }>;
    const byTime = [...ocrWithFrame].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const seen = new Set<number>();
    const uniqueByTime: number[] = [];
    for (const e of byTime) {
      if (seen.has(e.frameId)) continue;
      seen.add(e.frameId);
      uniqueByTime.push(e.frameId);
    }
    if (uniqueByTime.length === 0) return { frameIds, timestamps };
    const n = Math.min(MAX_SCREENSHOTS, uniqueByTime.length);
    for (let i = 0; i < n; i++) {
      const idx = n === 1 ? 0 : Math.round((i / (n - 1)) * (uniqueByTime.length - 1));
      frameIds.push(uniqueByTime[idx]);
      const ocrAt = byTime.find((x) => x.frameId === uniqueByTime[idx]);
      timestamps.push(ocrAt ? new Date(ocrAt.timestamp).getTime() : 0);
    }
  }
  return { frameIds, timestamps };
}

function pickKeyFrameIds(events: UsageEvent[]): number[] {
  return pickKeyFrameIdsWithTimestamps(events).frameIds;
}

/** Nearest speech (audio) event before or at timeMs, within 30s. */
function nearestSpeechBefore(events: UsageEvent[], timeMs: number): string | null {
  let best: { text: string; delta: number } | null = null;
  for (const e of events) {
    if (e.type !== "audio" || !(e.text ?? "").trim()) continue;
    const t = new Date(e.timestamp).getTime();
    if (t > timeMs + 5000) continue;
    const delta = timeMs - t;
    if (delta < 0) continue;
    if (best == null || delta < best.delta) best = { text: (e.text ?? "").trim().slice(0, 120), delta };
  }
  return best?.text ?? null;
}

/** Build a short context string for each screenshot so the LLM can place it (e.g. "After: 'click New Ticket'"). */
export function getScreenshotContexts(events: UsageEvent[]): { frameIds: number[]; contexts: string[] } {
  const { frameIds, timestamps } = pickKeyFrameIdsWithTimestamps(events);
  const contexts: string[] = [];
  for (let i = 0; i < frameIds.length; i++) {
    const t = timestamps[i];
    const speech = nearestSpeechBefore(events, t);
    const timeStr = new Date(t).toISOString().slice(11, 19);
    if (speech) {
      contexts.push(`Screenshot ${i + 1} (${timeStr}): After narration: "${speech}${speech.length >= 120 ? "…" : ""}"`);
    } else {
      contexts.push(`Screenshot ${i + 1} (${timeStr}): Captured at this point in the session`);
    }
  }
  return { frameIds, contexts };
}

const FRAME_FETCH_RETRIES = 2;
const FRAME_FETCH_RETRY_DELAY_MS = 800;

/** Get frame image as buffer (from inline base64 or API). Retries on failure for transient unavailability. */
async function getFrameBuffer(
  frameId: number,
  frameBase64ById: Map<number, string>,
  baseUrl: string
): Promise<Buffer> {
  const inline = frameBase64ById.get(frameId);
  if (inline) return Buffer.from(inline, "base64");
  const url = `${baseUrl.replace(/\/$/, "")}/frames/${frameId}`;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= FRAME_FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Frame ${frameId}: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error("Empty frame");
      return buf;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < FRAME_FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, FRAME_FETCH_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr ?? new Error(`Failed to fetch frame ${frameId}`);
}

/** Save buffer to imagesDir as screen-{index+1}. Returns relative path. */
async function saveFrameBuffer(
  buf: Buffer,
  index: number,
  imagesDir: string
): Promise<string> {
  const ext = buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : "png";
  const filename = `screen-${index + 1}.${ext}`;
  const filePath = join(imagesDir, filename);
  await writeFile(filePath, buf);
  return `images/${filename}`;
}

export interface WriteDocsOptions {
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

export async function writeDocsToFolder(options: WriteDocsOptions): Promise<{ path: string; imagesCount: number; framesFailed?: number }> {
  const folder = expandPath(options.outputFolder);
  const imagesDir = join(folder, "images");
  await mkdir(imagesDir, { recursive: true });

  const baseUrl = options.baseUrl ?? SCREENPIPE_API;
  const frameIds = pickKeyFrameIds(options.events);
  const frameBase64ById = new Map<number, string>();
  for (const e of options.events) {
    if (e.type === "ocr" && e.frameId != null && (e as UsageEvent & { frameBase64?: string }).frameBase64) {
      frameBase64ById.set(e.frameId, (e as UsageEvent & { frameBase64: string }).frameBase64);
    }
  }
  const imagePaths: string[] = [];
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
    body += `\n\n---\n\n## Screenshots\n\n`;
    imagePaths.forEach((rel, i) => {
      body += `\n![Screen ${i + 1}](${rel})\n\n`;
    });
  }

  const title = `# ${options.productName} – Documentation (generated from usage)\n\n`;
  const subtitle = `*Generated from Screenpipe usage between ${options.startTime} and ${options.endTime}.*\n\n---\n\n`;
  let fullMarkdown = title + subtitle + body;

  const safeName = options.productName.replace(/[^a-zA-Z0-9-_]/g, "-");
  const dateStr = new Date().toISOString().slice(0, 10);

  if (failedFrames > 0) {
    const total = frameIds.length;
    const loaded = imagePaths.length;
    const tip =
      "Download right after stopping recording while Screenpipe is still running (same session). If you closed the recorder or waited a long time, frames may have been purged.";
    if (loaded === 0) {
      fullMarkdown += `\n\n---\n*Screenshot images could not be loaded (${failedFrames} frame(s) unavailable). ${tip}*`;
    } else {
      fullMarkdown += `\n\n---\n*${failedFrames} of ${total} screenshot(s) could not be loaded (frame(s) unavailable). ${tip}*`;
    }
  }

  if (options.outputFormat === "docx") {
    const docxPath = join(folder, `${safeName}-${dateStr}.docx`);
    const docxBuf = await markdownToDocx(fullMarkdown, folder);
    await writeFile(docxPath, docxBuf);
    return { path: docxPath, imagesCount: imagePaths.length, framesFailed: failedFrames > 0 ? failedFrames : undefined };
  }

  const mdPath = join(folder, `${safeName}-${dateStr}.md`);
  await writeFile(mdPath, fullMarkdown, "utf-8");
  return { path: mdPath, imagesCount: imagePaths.length, framesFailed: failedFrames > 0 ? failedFrames : undefined };
}

/** Convert markdown string to docx buffer; images are relative to baseDir. */
async function markdownToDocx(markdown: string, baseDir: string): Promise<Buffer> {
  const docx = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun } = docx;

  const lines = markdown.split(/\r?\n/);
  const children: InstanceType<typeof Paragraph>[] = [];
  const imageDir = join(baseDir, "images");

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
      const absPath = relPath.startsWith("images/") ? join(baseDir, relPath) : join(imageDir, relPath);
      try {
        const buf = await readFile(absPath);
        const ext = absPath.toLowerCase().endsWith(".png") ? "png" : "jpg";
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                data: buf,
                type: ext as "png" | "jpg",
                transformation: { width: 480, height: 300 },
              }),
            ],
          })
        );
      } catch {
        children.push(new Paragraph({ children: [new TextRun(trimmed)] }));
      }
      continue;
    }
    const boldRegex = /\*\*([^*]+)\*\*/g;
    const runs: InstanceType<typeof TextRun>[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = new Document({ sections: [{ children }] } as any);
  return Packer.toBuffer(doc);
}
