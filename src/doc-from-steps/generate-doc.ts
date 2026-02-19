/**
 * AI documentation generator: converts workflow steps into step title, instruction, explanation, tips, warnings.
 */
import OpenAI from "openai";
import type { WorkflowStep, RenderedStep } from "../core-types.js";

const DEFAULT_MODEL = "gpt-5.2";

function stepsToPromptText(steps: WorkflowStep[]): string {
  return steps
    .map((s, i) => {
      const parts = [
        `Step ${s.stepNumber}: action=${s.action}`,
        s.target ? `target="${s.target}"` : "",
        s.position ? `position=(${s.position.x},${s.position.y})` : "",
        s.contextText ? `context="${s.contextText.slice(0, 200)}"` : "",
      ].filter(Boolean);
      return parts.join(", ");
    })
    .join("\n");
}

export interface GenerateDocFromStepsOptions {
  steps: WorkflowStep[];
  productName?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  model?: string;
}

export async function generateDocFromSteps(
  options: GenerateDocFromStepsOptions
): Promise<RenderedStep[]> {
  const apiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI API key not set. Set OPENAI_API_KEY or pass openaiApiKey.");
  }

  const client = new OpenAI({
    apiKey,
    baseURL: options.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? undefined,
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

Keep instructions concise and actionable. Use the step's target and context to make titles and instructions specific. Output only the JSON array, no markdown.`,
      },
      {
        role: "user",
        content: `Product: ${productName}\n\nSteps:\n${stepsText}\n\nOutput a JSON array with one object per step, in order. Keys: title, instruction, explanation (optional), tips (optional), warnings (optional).`,
      },
    ],
    max_completion_tokens: 4096,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error("LLM returned no content");

  let parsed: Array<{ title?: string; instruction?: string; explanation?: string; tips?: string[]; warnings?: string[] }>;
  try {
    const jsonStr = content.replace(/^```json?\s*|\s*```$/g, "").trim();
    parsed = JSON.parse(jsonStr) as Array<{
      title?: string;
      instruction?: string;
      explanation?: string;
      tips?: string[];
      warnings?: string[];
    }>;
  } catch {
    throw new Error("LLM did not return valid JSON array");
  }

  const rendered: RenderedStep[] = [];
  for (let i = 0; i < options.steps.length; i++) {
    const step = options.steps[i];
    const p = parsed[i] ?? {};
    rendered.push({
      stepNumber: step.stepNumber,
      title: p.title ?? `Step ${step.stepNumber}`,
      instruction: p.instruction ?? step.target ?? step.action,
      explanation: p.explanation,
      tips: p.tips,
      warnings: p.warnings,
    });
  }
  return rendered;
}
