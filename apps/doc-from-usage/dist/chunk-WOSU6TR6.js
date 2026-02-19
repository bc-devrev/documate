import {
  fetchUsageEvents,
  generateDocumentation,
  getOpenAiApiKey,
  loadConfig,
  writeDocsToFolder
} from "./chunk-QQ25LSWF.js";

// src/index.ts
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
async function runDocFromUsage(config) {
  let events;
  try {
    events = await fetchUsageEvents({
      baseUrl: config.screenpipeBaseUrl,
      appName: config.appName,
      windowName: config.windowName,
      startTime: config.startTime,
      endTime: config.endTime,
      limit: config.limit
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause;
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : "";
    if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || code === "ECONNREFUSED") {
      const base = config.screenpipeBaseUrl.replace(/\/$/, "");
      throw new Error(
        "Screenpipe is not running (connection refused to " + base + "). Start it first: npm run record . Leave that running, then run record:stop (saves end time), then run generate. Do not kill or close Screenpipe until after generate."
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
        startTime: new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString(),
        endTime: (/* @__PURE__ */ new Date()).toISOString(),
        limit: 5
      });
      if (anyEvents.length > 0) {
        hint = " The API has data from the last 24h but none in your requested window. Try: --hours 1 (ignores recording file). ";
      }
    } catch {
      hint = " Check Screenpipe is running: curl " + base + "/health . ";
    }
    throw new Error(
      "No events in this time range." + hint + '(1) Run generate before killing Screenpipe (record:stop does not kill it). (2) Try a wider range: --hours 1 . (3) Try without --app. (4) macOS: grant Screen Recording + Input Monitoring to Node/Terminal. (5) Debug (no time filter): curl "' + base + '/search?content_type=ocr&limit=5" '
    );
  }
  const productName = config.productName ?? config.appName ?? "Product";
  const openaiApiKey = config.openaiApiKey ?? await getOpenAiApiKey();
  const markdownBody = await generateDocumentation({
    events,
    productName,
    openaiApiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    model: config.model
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
      baseUrl: config.screenpipeBaseUrl
    });
    return { outputPath: result.path, eventsCount: events.length, imagesCount: result.imagesCount };
  }
  const outputPath = config.outputPath ?? `${productName.replace(/[^a-zA-Z0-9-_]/g, "-")}-docs.md`;
  const title = `# ${productName} \u2013 Documentation (generated from usage)

`;
  const fullDoc = title + `*Generated from Screenpipe usage between ${config.startTime} and ${config.endTime}.*

---

` + markdownBody;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, fullDoc, "utf-8");
  return { outputPath, eventsCount: events.length };
}

export {
  runDocFromUsage
};
