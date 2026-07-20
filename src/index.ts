import { fetchUsageEvents } from "./fetch-usage.js";
import { generateDocumentation } from "./generate-docs.js";
import { getAwsRegion, getBedrockModel, loadConfig } from "./config.js";
import { writeDocsToFolder } from "./write-docs.js";
import type { DocFromUsageConfig } from "./types.js";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

export type { DocFromUsageConfig, UsageEvent } from "./types.js";
export { fetchUsageEvents } from "./fetch-usage.js";
export { generateDocumentation } from "./generate-docs.js";
export { writeDocsToFolder } from "./write-docs.js";

/**
 * Main entry: fetch usage from Screenpipe, generate docs with AI, write to folder (or single file).
 * When outputFolder is set (or from saved config), writes to that folder with images; otherwise uses outputPath.
 */
export async function runDocFromUsage(config: DocFromUsageConfig): Promise<{ outputPath: string; eventsCount: number; imagesCount?: number }> {
  let events: Awaited<ReturnType<typeof fetchUsageEvents>>;
  try {
    events = await fetchUsageEvents({
      baseUrl: config.screenpipeBaseUrl,
      appName: config.appName,
      windowName: config.windowName,
      startTime: config.startTime,
      endTime: config.endTime,
      limit: config.limit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && (err as Error & { cause?: { code?: string } }).cause;
    const code = cause && typeof cause === "object" && "code" in cause ? (cause as { code: string }).code : "";
    if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || code === "ECONNREFUSED") {
      const base = config.screenpipeBaseUrl.replace(/\/$/, "");
      throw new Error(
        "Screenpipe is not running (connection refused to " +
          base +
          "). Start it first: npm run record . Leave that running, then run record:stop (saves end time), then run generate. Do not kill or close Screenpipe until after generate."
      );
    }
    throw err;
  }

  if (events.length === 0) {
    const base = config.screenpipeBaseUrl.replace(/\/$/, "");
    let hint = "";
    try {
      const anyEvents = await fetchUsageEvents({
        baseUrl: config.screenpipeBaseUrl,
        startTime: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        endTime: new Date().toISOString(),
        limit: 5,
      });
      if (anyEvents.length > 0) {
        hint =
          " The API has data from the last 24h but none in your requested window. Try: --hours 1 (ignores recording file). ";
      }
    } catch {
      hint = " Check Screenpipe is running: curl " + base + "/health . ";
    }
    throw new Error(
      "No events in this time range." +
        hint +
        "(1) Run generate before killing Screenpipe (record:stop does not kill it). " +
        "(2) Try a wider range: --hours 1 . " +
        "(3) Try without --app. " +
        "(4) macOS: grant Screen Recording + Input Monitoring to Node/Terminal. " +
        "(5) Debug (no time filter): curl \"" +
        base +
        "/search?content_type=ocr&limit=5\" "
    );
  }

  const productName = config.productName ?? config.appName ?? "Product";
  const awsRegion = config.awsRegion ?? (await getAwsRegion());
  const model = config.model ?? (await getBedrockModel());
  const markdownBody = await generateDocumentation({
    events,
    productName,
    awsRegion,
    model,
  });

  const outputFolder = config.outputFolder ?? (await loadConfig()).outputFolder;
  const outputFormat = config.outputFormat ?? (await loadConfig()).outputFormat ?? "markdown";

  if (outputFolder) {
    const result = await writeDocsToFolder({
      outputFolder,
      outputFormat: outputFormat ?? "markdown",
      productName,
      markdownBody,
      startTime: config.startTime,
      endTime: config.endTime,
      events,
      baseUrl: config.screenpipeBaseUrl,
    });
    return { outputPath: result.path, eventsCount: events.length, imagesCount: result.imagesCount };
  }

  const outputPath = config.outputPath ?? `${productName.replace(/[^a-zA-Z0-9-_]/g, "-")}-docs.md`;
  const title = `# ${productName} – Documentation (generated from usage)\n\n`;
  const fullDoc = title + `*Generated from Screenpipe usage between ${config.startTime} and ${config.endTime}.*\n\n---\n\n` + markdownBody;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, fullDoc, "utf-8");
  return { outputPath, eventsCount: events.length };
}
