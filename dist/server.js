import {
  getRecordingTimeRange,
  setRecordingEndTime,
  setRecordingStartTime
} from "./chunk-PX6PI2KN.js";
import {
  buildRawTracePayload,
  fetchUsageEvents,
  generateDocumentation,
  getDeepgramApiKey,
  getOpenAiApiKey,
  getScreenshotContexts,
  loadConfig,
  saveConfig,
  writeDocsToFolder
} from "./chunk-QQ25LSWF.js";

// src/server.ts
import { spawn } from "child_process";
import { createServer } from "http";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { readdirSync, statSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import archiver from "archiver";
var __dirname = dirname(fileURLToPath(import.meta.url));
var PUBLIC_DIR = join(__dirname, "..", "public");
var SCREENPIPE_API = process.env.SCREENPIPE_API ?? "http://localhost:3030";
var PORT = Number(process.env.DOC_FROM_USAGE_PORT) || 3040;
var recordingProcess = null;
var recordingStartTime = null;
var lastRecordingError = null;
var weStartedRecording = false;
async function screenpipeHealth() {
  const maxTries = recordingProcess ? 6 : 1;
  const delayMs = 2e3;
  for (let try_ = 0; try_ < maxTries; try_++) {
    try {
      const r = await fetch(`${SCREENPIPE_API}/health`, { signal: AbortSignal.timeout(8e3) });
      if (!r.ok) return { ok: false, message: `Screenpipe returned ${r.status}` };
      const data = await r.json();
      const frameStatus = data.frame_status ?? data.frameStatus ?? "";
      const audioStatus = data.audio_status ?? data.audioStatus ?? "";
      const frameOk = frameStatus === "ok" || frameStatus === "healthy";
      const audioOk = audioStatus === "ok" || audioStatus === "healthy" || audioStatus === "disabled";
      return {
        ok: true,
        message: frameOk && audioOk ? "Recording active" : "Screenpipe up; check permissions if not recording",
        audioStatus,
        frameStatus
      };
    } catch (e) {
      if (try_ < maxTries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return { ok: false, message: "Screenpipe not running. Click Start recording to begin." };
    }
  }
  return { ok: false, message: "Screenpipe not running. Click Start recording to begin." };
}
function getScreenpipeCliPath() {
  try {
    const require2 = createRequire(import.meta.url);
    return require2.resolve("screenpipe/bin/screenpipe.js");
  } catch {
    return null;
  }
}
function startRecording(options) {
  if (recordingProcess) {
    return { ok: false, message: "Recording already started (stop it first)" };
  }
  lastRecordingError = null;
  recordingStartTime = Date.now();
  weStartedRecording = true;
  setRecordingStartTime(new Date(recordingStartTime).toISOString()).catch(() => {
  });
  const cliPath = getScreenpipeCliPath();
  if (!cliPath) {
    lastRecordingError = "screenpipe package not found. Run: npm install";
    return { ok: false, message: lastRecordingError };
  }
  const deepgramKey = options?.deepgramApiKey?.trim() || process.env.DEEPGRAM_API_KEY;
  const enableRealtime = Boolean(deepgramKey);
  const env = { ...process.env, ...deepgramKey ? { DEEPGRAM_API_KEY: deepgramKey } : {} };
  const args = enableRealtime && deepgramKey ? [cliPath, "record", "--enable-realtime-audio-transcription", "--deepgram-api-key", deepgramKey, "--enable-ui-events"] : [cliPath, "record", "--enable-ui-events"];
  try {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
      env,
      cwd: process.cwd()
    });
    recordingProcess = child;
    let stderr = "";
    child.stderr?.on("data", (d) => stderr += d.toString());
    const startAt = Date.now();
    child.on("exit", (code, signal) => {
      recordingProcess = null;
      if (code !== 0 && code !== null) {
        lastRecordingError = stderr.trim() || `Process exited with code ${code}`;
      } else if (Date.now() - startAt < 15e3 && stderr.trim()) {
        const benign = /file descriptor limit already sufficient|increased file descriptor limit/i.test(stderr);
        if (!benign) lastRecordingError = stderr.trim();
      }
    });
    child.unref?.();
    const message = enableRealtime ? "Recording started with speech transcription. Wait for 'Recording active' and 'Microphone: recording speech' below." : "Recording started. Wait for 'Recording active' below. (Save a Deepgram key to include your speech in the doc.)";
    return { ok: true, message, speechEnabled: enableRealtime };
  } catch (e) {
    recordingProcess = null;
    recordingStartTime = null;
    lastRecordingError = e instanceof Error ? e.message : "Failed to start";
    return { ok: false, message: lastRecordingError };
  }
}
function stopRecording() {
  setRecordingEndTime((/* @__PURE__ */ new Date()).toISOString()).catch(() => {
  });
  if (!recordingProcess) {
    weStartedRecording = false;
    if (lastRecordingError) {
      return {
        ok: false,
        message: "No recording process is running. Start failed earlier: " + lastRecordingError.slice(0, 180) + ". Run in a terminal: npx screenpipe record"
      };
    }
    return {
      ok: true,
      message: "Recording end time saved. Click Download to generate docs (Screenpipe must stay running). When done, stop Screenpipe in a terminal: pkill -f screenpipe"
    };
  }
  recordingProcess = null;
  weStartedRecording = false;
  return {
    ok: true,
    message: "Recording end time saved. Click Download now to generate docs. Screenpipe is still running so Download can fetch data. When done: pkill -f screenpipe"
  };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}
function sendNotFound(res) {
  res.writeHead(404);
  res.end("Not found");
}
async function handleDownload(res, format, productName, hoursBack, appName, windowName) {
  const recordingRange = await getRecordingTimeRange();
  const startTime = recordingRange ? recordingRange.startTime : new Date(recordingStartTime ?? Date.now() - hoursBack * 60 * 60 * 1e3).toISOString();
  let endTime = recordingRange ? recordingRange.endTime : (/* @__PURE__ */ new Date()).toISOString();
  const endMs = new Date(endTime).getTime() + 90 * 1e3;
  const endTimeWithBuffer = new Date(endMs).toISOString();
  const apiKey = await getOpenAiApiKey();
  if (!apiKey) {
    sendJson(res, { error: "OpenAI API key not set. Save your key in the UI first." }, 400);
    return;
  }
  let tmpDir = null;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "doc-from-usage-"));
    let events;
    try {
      events = await fetchUsageEvents({
        baseUrl: SCREENPIPE_API,
        startTime,
        endTime: endTimeWithBuffer,
        limit: 500,
        appName: appName || void 0,
        windowName: windowName || void 0,
        includeFrames: true
      });
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        sendJson(res, { error: "Screenpipe is not running. Click Start recording and wait until status shows 'Recording active', then try Download again." }, 503);
        return;
      }
      throw fetchErr;
    }
    if (events.length === 0) {
      sendJson(res, {
        error: "No usage data in this time range. Make sure you: 1) Click Start recording and wait for 'Recording active'. 2) Use your product (open the app, click around, use features). 3) Then click Download. Optionally filter by the exact app name (e.g. your app or 'Chrome')."
      }, 400);
      return;
    }
    const { contexts: screenshotContexts } = getScreenshotContexts(events);
    const rawTracePayload = buildRawTracePayload({
      events,
      productName,
      screenshotContexts: screenshotContexts.length > 0 ? screenshotContexts : void 0
    });
    if (process.env.DOC_FROM_USAGE_SAVE_RAW_TRACE === "1") {
      const traceDir = join(homedir(), ".doc-from-usage");
      await mkdir(traceDir, { recursive: true }).catch(() => {
      });
      await writeFile(join(traceDir, "last-raw-trace.txt"), rawTracePayload, "utf-8").catch(() => {
      });
    }
    let markdownBody = await generateDocumentation({
      events,
      productName,
      openaiApiKey: apiKey,
      model: process.env.DOC_FROM_USAGE_MODEL,
      screenshotContexts: screenshotContexts.length > 0 ? screenshotContexts : void 0
    });
    const audioCountForNote = events.filter((e) => e.type === "audio").length;
    const inputCountForNote = events.filter((e) => e.type === "input").length;
    if (audioCountForNote === 0) {
      markdownBody += "\n\n---\n\n**Note:** No spoken narration was recorded in this trace. The capture may include a separate local page (Doc from Usage / Screenpipe) with instructions, but no speech was transcribed. If you re-record with audio transcription enabled (save your Deepgram API key in the Doc from Usage UI, then Start recording), your narration (e.g., \u201CI\u2019m clicking Create ticket to start a new ticket\u201D) can be quoted directly in these guides.";
    }
    if (inputCountForNote === 0) {
      markdownBody += "\n\n---\n\n**Note:** No click or scroll events were recorded, so screenshots are spread by time instead of at each action. For one screenshot per click, start a new recording using **Start recording** in Doc from Usage (click capture is enabled). You may need to grant Input Monitoring permission to Screenpipe in System Settings \u2192 Privacy & Security.";
    }
    const result = await writeDocsToFolder({
      outputFolder: tmpDir,
      outputFormat: format,
      productName,
      markdownBody,
      startTime,
      endTime,
      events,
      baseUrl: SCREENPIPE_API
    });
    const safeName = productName.replace(/[^a-zA-Z0-9-_]/g, "-");
    const dateStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const ocrCount = events.filter((e) => e.type === "ocr").length;
    const inputCount = events.filter((e) => e.type === "input").length;
    const audioCount = events.filter((e) => e.type === "audio").length;
    const eventCountHeader = {
      "X-Event-Count": String(events.length),
      "X-OCR-Count": String(ocrCount),
      "X-Input-Count": String(inputCount),
      "X-Audio-Count": String(audioCount),
      "X-Screenshot-Count": String(result.imagesCount)
    };
    if (format === "docx") {
      const buf = await readFile(result.path);
      res.writeHead(200, {
        ...eventCountHeader,
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${safeName}-${dateStr}.docx"`,
        "Content-Length": buf.length
      });
      res.end(buf);
    } else {
      const zipFilename = `${safeName}-${dateStr}.zip`;
      res.writeHead(200, {
        ...eventCountHeader,
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipFilename}"`
      });
      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.pipe(res);
      const dir = dirname(result.path);
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isFile()) {
          archive.file(full, { name });
        } else if (stat.isDirectory()) {
          archive.directory(full, name);
        }
      }
      await archive.finalize();
    }
  } catch (e) {
    if (!res.headersSent) {
      const msg = e instanceof Error ? e.message : "Failed to generate documentation";
      if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        sendJson(res, { error: "Screenpipe is not running. Start recording and wait for 'Recording active' before downloading." }, 503);
      } else {
        sendJson(res, { error: msg }, 500);
      }
    }
  } finally {
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
      }
    }
  }
}
var server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const html = await readFile(join(PUBLIC_DIR, "index.html"), "utf-8");
      sendHtml(res, html);
    } catch {
      sendNotFound(res);
    }
    return;
  }
  if (url.pathname === "/api/health") {
    const health = await screenpipeHealth();
    sendJson(res, {
      ...health,
      recordingError: lastRecordingError ?? void 0,
      startedButExited: weStartedRecording && !recordingProcess
    });
    return;
  }
  if (url.pathname === "/api/recording/start" && req.method === "POST") {
    const deepgramApiKey = await getDeepgramApiKey();
    sendJson(res, startRecording({ deepgramApiKey }));
    return;
  }
  if (url.pathname === "/api/recording/stop" && req.method === "POST") {
    sendJson(res, stopRecording());
    return;
  }
  if (url.pathname === "/api/recording/ready" && req.method === "GET") {
    try {
      const range = await getRecordingTimeRange();
      if (!range?.endTime) {
        sendJson(res, { ready: true });
        return;
      }
      const endMs = new Date(range.endTime).getTime();
      const now = Date.now();
      if (now - endMs > 2 * 60 * 1e3) {
        sendJson(res, { ready: true });
        return;
      }
      const startTime = range.startTime;
      const endTimeWithBuffer = new Date(endMs + 90 * 1e3).toISOString();
      const searchUrl = `${SCREENPIPE_API.replace(/\/$/, "")}/search?content_type=ocr&start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTimeWithBuffer)}&limit=1&offset=0`;
      const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(1e4) });
      if (!searchRes.ok) {
        sendJson(res, { ready: false, total: void 0, message: "Screenpipe search failed" });
        return;
      }
      const searchData = await searchRes.json();
      const total = searchData.pagination?.total ?? (Array.isArray(searchData.data) ? searchData.data.length : 0);
      sendJson(res, { ready: false, total });
    } catch (e) {
      sendJson(res, { ready: false, total: void 0, message: e instanceof Error ? e.message : "Check failed" });
    }
    return;
  }
  if (url.pathname === "/api/recording/last-error" && req.method === "GET") {
    sendJson(res, { error: lastRecordingError });
    return;
  }
  if (url.pathname === "/api/raw-trace" && req.method === "GET") {
    try {
      const recordingRange = await getRecordingTimeRange();
      const startTime = recordingRange ? recordingRange.startTime : new Date(Date.now() - 2 * 60 * 60 * 1e3).toISOString();
      let endTime = recordingRange ? recordingRange.endTime : (/* @__PURE__ */ new Date()).toISOString();
      const endMs = new Date(endTime).getTime() + 90 * 1e3;
      const endTimeWithBuffer = new Date(endMs).toISOString();
      const appName = url.searchParams.get("appName")?.trim() || void 0;
      const windowName = url.searchParams.get("windowName")?.trim() || void 0;
      const productName = url.searchParams.get("productName")?.trim() || "Product";
      const events = await fetchUsageEvents({
        baseUrl: SCREENPIPE_API,
        startTime,
        endTime: endTimeWithBuffer,
        limit: 500,
        appName,
        windowName,
        includeFrames: false
      });
      if (events.length === 0) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("(no events in this time range)");
        return;
      }
      const { contexts: screenshotContexts } = getScreenshotContexts(events);
      const raw = buildRawTracePayload({
        events,
        productName,
        screenshotContexts: screenshotContexts.length > 0 ? screenshotContexts : void 0
      });
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": "inline; filename=raw-trace.txt"
      });
      res.end(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Failed to build raw trace: " + msg);
    }
    return;
  }
  if (url.pathname === "/api/download-docs" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || "{}");
      const format = body.format ?? "markdown";
      const productName = (body.productName ?? "Product").trim() || "Product";
      const hoursBack = typeof body.hours === "number" ? body.hours : 2;
      await handleDownload(res, format, productName, hoursBack, body.appName?.trim(), body.windowName?.trim());
    } catch (e) {
      sendJson(res, { error: e instanceof Error ? e.message : "Bad request" }, 400);
    }
    return;
  }
  if (url.pathname === "/api/settings" && req.method === "GET") {
    const config = await loadConfig();
    sendJson(res, {
      hasOpenAiKey: Boolean(config.openaiApiKey),
      hasDeepgramKey: Boolean(config.deepgramApiKey)
    });
    return;
  }
  if (url.pathname === "/api/settings" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const updates = {};
      if (body.openaiApiKey !== void 0) updates.openaiApiKey = body.openaiApiKey || void 0;
      if (body.deepgramApiKey !== void 0) updates.deepgramApiKey = body.deepgramApiKey || void 0;
      await saveConfig(updates);
      sendJson(res, { ok: true });
    } catch {
      sendJson(res, { ok: false }, 400);
    }
    return;
  }
  sendNotFound(res);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
    console.error(`Either stop the other process using port ${PORT}, or run with a different port:`);
    console.error(`  DOC_FROM_USAGE_PORT=3041 npm run ui`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, () => {
  console.log(`Doc-from-usage UI: http://localhost:${PORT}`);
  console.log(`Screenpipe API:   ${SCREENPIPE_API}`);
});
