#!/usr/bin/env node
import {
  runDocFromUsage
} from "./chunk-WOSU6TR6.js";
import {
  getRecordingTimeRange,
  startRecording,
  stopRecording
} from "./chunk-PX6PI2KN.js";
import "./chunk-QQ25LSWF.js";

// src/cli.ts
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    command: "generate",
    stopRecord: false
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "record") {
      out.command = "record";
      if (args[i + 1] === "--stop") {
        out.stopRecord = true;
        i++;
      }
    } else if (args[i] === "--app" && args[i + 1]) {
      out.appName = args[++i];
    } else if (args[i] === "--window" && args[i + 1]) {
      out.windowName = args[++i];
    } else if (args[i] === "--hours" && args[i + 1]) {
      out.hours = Number(args[++i]);
    } else if (args[i] === "--start" && args[i + 1]) {
      out.start = args[++i];
    } else if (args[i] === "--end" && args[i + 1]) {
      out.end = args[++i];
    } else if (args[i] === "--out" && args[i + 1]) {
      out.out = args[++i];
    } else if (args[i] === "--output-folder" && args[i + 1]) {
      out.outputFolder = args[++i];
    } else if (args[i] === "--format" && args[i + 1]) {
      out.format = args[++i];
    } else if (args[i] === "--product" && args[i + 1]) {
      out.productName = args[++i];
    } else if (args[i] === "--api" && args[i + 1]) {
      out.api = args[++i];
    } else if (args[i] === "--limit" && args[i + 1]) {
      out.limit = Number(args[++i]);
    } else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}
function printHelp() {
  console.log(`
doc-from-usage \u2013 Record usage and generate docs from Screenpipe + OpenAI (no web UI).

Commands:
  record              Start Screenpipe recording in the background.
  record --stop       Save recording end time (Screenpipe keeps running so generate can fetch data).

  (default)           Generate docs. Uses recording start\u2192stop time if you ran
                      'record' then 'record --stop'; else uses --hours (default 2).
                      Requires: --out <file> OR --output-folder <dir>.

Generate options:
  --out <path>        Write single markdown file (no images).
  --output-folder <dir>  Write folder with markdown + images (or docx).
  --format markdown|docx   With --output-folder only. Default: markdown.
  --app <name>       Filter by app (e.g. Chrome). Use "Chrome" for browser-only.
  --window <title>   Filter by window title.
  --hours <N>        Fallback: use last N hours if no recording range (default: 2).
  --start <ISO>      Start time (overrides --hours).
  --end <ISO>        End time (default: now).
  --product <name>   Product name in the doc (default: from --app or "Product").
  --api <URL>        Screenpipe API base URL (default: http://localhost:3030).
  --limit <N>        Max events to fetch (default: 100).

Env: OPENAI_API_KEY (required), DOC_FROM_USAGE_MODEL (optional).

Audio: When you start recording with "doc-from-usage record", realtime transcription is
enabled so your speech is included in the doc. If you run Screenpipe yourself, use:
  npx screenpipe record --enable-realtime-audio-transcription

Examples:
  doc-from-usage record
  # ... use your product; you can speak while recording ...
  doc-from-usage record --stop    # saves end time; do NOT kill Screenpipe yet
  doc-from-usage --out ./docs.md  # run while Screenpipe is still running
  pkill -f screenpipe            # or: npm run record:kill

  # Custom time range instead of recording range:
  doc-from-usage --out ./docs.md --hours 1
  doc-from-usage --output-folder ./my-docs --start 2025-02-18T10:00:00Z --end 2025-02-18T11:00:00Z
`);
}
async function main() {
  const {
    command,
    stopRecord,
    appName,
    windowName,
    hours = 2,
    start,
    end,
    out: outputPath,
    outputFolder,
    format,
    productName,
    api: screenpipeBaseUrl = "http://localhost:3030",
    limit = 100
  } = parseArgs();
  if (command === "record") {
    if (stopRecord) {
      const result = await stopRecording();
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
    } else {
      const result = await startRecording();
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
    }
  }
  if (!outputPath && !outputFolder) {
    console.error("Usage: doc-from-usage (--out <file> | --output-folder <dir>) [options]");
    console.error("       doc-from-usage record   to start recording; doc-from-usage record --stop to stop.");
    console.error("       doc-from-usage --help   for full help.");
    process.exit(1);
  }
  let startTime;
  let endTime;
  if (start != null || end != null) {
    endTime = end ? new Date(end).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
    startTime = start ? new Date(start).toISOString() : new Date(Date.parse(endTime) - hours * 60 * 60 * 1e3).toISOString();
  } else {
    const recordingRange = await getRecordingTimeRange();
    if (recordingRange) {
      const bufferMs = 30 * 1e3;
      const startMs = Math.max(0, new Date(recordingRange.startTime).getTime() - bufferMs);
      const endMs = new Date(recordingRange.endTime).getTime() + bufferMs;
      startTime = new Date(startMs).toISOString();
      endTime = new Date(endMs).toISOString();
      console.error("Using recording time range: " + startTime + " to " + endTime);
    } else {
      const endDate = /* @__PURE__ */ new Date();
      endTime = endDate.toISOString();
      startTime = new Date(endDate.getTime() - hours * 60 * 60 * 1e3).toISOString();
    }
  }
  runDocFromUsage({
    screenpipeBaseUrl,
    appName,
    windowName,
    startTime,
    endTime,
    limit,
    outputPath: outputPath ?? void 0,
    outputFolder,
    outputFormat: format,
    productName: productName ?? appName,
    model: process.env.DOC_FROM_USAGE_MODEL
  }).then(({ outputPath: out, eventsCount, imagesCount }) => {
    console.log(
      `Wrote documentation to ${out} (${eventsCount} events${imagesCount != null ? `, ${imagesCount} screenshots` : ""}).`
    );
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
main();
