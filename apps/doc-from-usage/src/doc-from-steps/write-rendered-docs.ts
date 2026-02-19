/**
 * Writes rendered steps (title, instruction, explanation, tips, warnings + optional images) to a folder.
 */
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { RenderedStep } from "../core-types.js";

export async function writeRenderedStepsToFolder(options: {
  outputFolder: string;
  productName: string;
  renderedSteps: RenderedStep[];
}): Promise<{ markdownPath: string; imageDir: string }> {
  const { outputFolder, productName, renderedSteps } = options;
  await mkdir(outputFolder, { recursive: true });
  const imagesDir = join(outputFolder, "images");
  await mkdir(imagesDir, { recursive: true });

  const lines: string[] = [
    `# ${productName} – Step-by-step guide`,
    "",
    "Generated from recorded usage.",
    "",
    "---",
    "",
  ];

  for (const step of renderedSteps) {
    lines.push(`## ${step.stepNumber}. ${step.title}`);
    lines.push("");
    lines.push(step.instruction);
    lines.push("");
    if (step.explanation) {
      lines.push(`*${step.explanation}*");
      lines.push("");
    }
    if (step.imageBuffer) {
      const imageName = `step-${step.stepNumber}.png`;
      await writeFile(join(imagesDir, imageName), step.imageBuffer);
      lines.push(`![Step ${step.stepNumber}](./images/${imageName})`);
      lines.push("");
    }
    if (step.tips?.length) {
      lines.push("**Tips:**");
      for (const t of step.tips) lines.push(`- ${t}`);
      lines.push("");
    }
    if (step.warnings?.length) {
      lines.push("**Warnings:**");
      for (const w of step.warnings) lines.push(`- ${w}`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  const markdownPath = join(outputFolder, "steps.md");
  await writeFile(markdownPath, lines.join("\n"), "utf-8");
  return { markdownPath, imageDir };
}
