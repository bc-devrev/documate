/**
 * Full pipeline: import session → detect steps → (optional) render screenshots → AI doc from steps.
 */
import { importSessions } from "./session/import-session.js";
import { loadSession } from "./session/session-store.js";
import { detectSteps } from "./workflow/detect-steps.js";
import { renderStepScreenshot } from "./screenshot/render-step.js";
import { generateDocFromSteps } from "./doc-from-steps/generate-doc.js";
import type { Session, WorkflowStep, RenderedStep } from "./core-types.js";

export interface PipelineOptions {
  baseUrl: string;
  startTime: string;
  endTime: string;
  appName?: string;
  windowName?: string;
  storeBaseDir: string;
  productName?: string;
  awsRegion?: string;
  /** If true, fetch frame and draw hotspot for each step with position+frameId. */
  renderScreenshots?: boolean;
}

export interface PipelineResult {
  sessions: Session[];
  steps: WorkflowStep[];
  renderedSteps: RenderedStep[];
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { baseUrl, storeBaseDir, productName, awsRegion, renderScreenshots = false } = options;

  const { sessions } = await importSessions({
    baseUrl,
    startTime: options.startTime,
    endTime: options.endTime,
    appName: options.appName,
    windowName: options.windowName,
    storeBaseDir,
  });

  if (sessions.length === 0) {
    return { sessions: [], steps: [], renderedSteps: [] };
  }

  const session = sessions[0];
  const steps = detectSteps(session.events);

  const renderedSteps = await generateDocFromSteps({
    steps,
    productName,
    awsRegion,
  });

  if (renderScreenshots && baseUrl) {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.frameId != null && step.position) {
        try {
          const buf = await renderStepScreenshot({ baseUrl, step });
          renderedSteps[i].imageBuffer = buf;
        } catch {
          // skip screenshot on error
        }
      }
    }
  }

  return { sessions, steps, renderedSteps };
}

export type { Session, WorkflowStep, RenderedStep };
export { importSessions } from "./session/import-session.js";
export { detectSteps } from "./workflow/detect-steps.js";
export { renderStepScreenshot, fetchFrameBuffer } from "./screenshot/render-step.js";
export { generateDocFromSteps } from "./doc-from-steps/generate-doc.js";
export { loadSession, listSessions, saveSession } from "./session/session-store.js";
