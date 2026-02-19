/**
 * For each step: fetch frame image, draw hotspot at click position, optional OCR highlight.
 * Supports circle hotspot, optional bounding box overlay.
 */
import sharp from "sharp";
import { ScreenpipeClient } from "@screenpipe/js";
import type { WorkflowStep } from "../core-types.js";
import type { TextBounds } from "@screenpipe/js";

export interface RenderStepOptions {
  baseUrl: string;
  step: WorkflowStep;
  /** Optional: highlight this bounding box (from OCR text position). */
  highlightBounds?: TextBounds;
  /** Hotspot style. */
  hotspotRadius?: number;
  hotspotStroke?: string;
  hotspotStrokeWidth?: number;
}

const DEFAULT_RADIUS = 16;
const DEFAULT_STROKE = "#e11";
const DEFAULT_STROKE_WIDTH = 3;

export async function renderStepScreenshot(options: RenderStepOptions): Promise<Buffer> {
  const {
    baseUrl,
    step,
    highlightBounds,
    hotspotRadius = DEFAULT_RADIUS,
    hotspotStroke = DEFAULT_STROKE,
    hotspotStrokeWidth = DEFAULT_STROKE_WIDTH,
  } = options;

  const client = new ScreenpipeClient({ baseUrl });
  let imageBuffer: Buffer;

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

  const overlays: Buffer[] = [];

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

/** Fetch frame as buffer (no annotation). */
export async function fetchFrameBuffer(baseUrl: string, frameId: number): Promise<Buffer> {
  const client = new ScreenpipeClient({ baseUrl });
  const res = await client.getFrame(frameId);
  if (!res.ok) throw new Error(`Failed to fetch frame ${frameId}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
