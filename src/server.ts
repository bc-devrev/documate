/**
 * Simple UI server: recording start/stop, OpenAI token, download docs after recording.
 * Run: npm run ui  (Node.js, no Bun required)
 */

import { spawn, type ChildProcess } from "child_process";
import { createServer } from "http";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { readdirSync, statSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import archiver from "archiver";
import { loadConfig, saveConfig, getOpenAiApiKey, getDeepgramApiKey } from "./config.js";
import { fetchUsageEvents } from "./fetch-usage.js";
import { generateDocumentation, buildRawTracePayload } from "./generate-docs.js";
import { writeDocsToFolder, getScreenshotContexts } from "./write-docs.js";
import { getRecordingTimeRange, setRecordingStartTime, setRecordingEndTime, clearRecordingState } from "./recording.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const SCREENPIPE_API = process.env.SCREENPIPE_API ?? "http://localhost:3030";
const PORT = Number(process.env.DOC_FROM_USAGE_PORT) || 3040;
/** Host to bind. Use 0.0.0.0 to allow access from other devices on the network. */
const HOST = process.env.DOC_FROM_USAGE_HOST ?? "127.0.0.1";

let recordingProcess: ChildProcess | null = null;
/** When the user clicked Start recording (ms since epoch). Used for download time range. */
let recordingStartTime: number | null = null;
/** If the recording process exited quickly, stderr or a short message for the UI. */
let lastRecordingError: string | null = null;
/** True after user clicked Start (so we can show a better Stop message if the process already exited). */
let weStartedRecording = false;

async function screenpipeHealth(): Promise<{
  ok: boolean;
  message?: string;
  audioStatus?: string;
  frameStatus?: string;
}> {
  const maxTries = recordingProcess ? 6 : 1;
  const delayMs = 2000;
  for (let try_ = 0; try_ < maxTries; try_++) {
    try {
      const r = await fetch(`${SCREENPIPE_API}/health`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { ok: false, message: `Screenpipe returned ${r.status}` };
      const data = (await r.json()) as {
        frame_status?: string;
        audio_status?: string;
        frameStatus?: string;
        audioStatus?: string;
      };
      const frameStatus = data.frame_status ?? data.frameStatus ?? "";
      const audioStatus = data.audio_status ?? data.audioStatus ?? "";
      const frameOk = frameStatus === "ok" || frameStatus === "healthy";
      const audioOk = audioStatus === "ok" || audioStatus === "healthy" || audioStatus === "disabled";
      return {
        ok: true,
        message: frameOk && audioOk ? "Recording active" : "Screenpipe up; check permissions if not recording",
        audioStatus,
        frameStatus,
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

/** Resolve path to screenpipe CLI bin script (avoids npx/shell so "screenpipe: command not found" never happens). */
function getScreenpipeCliPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("screenpipe/bin/screenpipe.js");
  } catch {
    return null;
  }
}

function startRecording(options?: { deepgramApiKey?: string }): { ok: boolean; message: string; speechEnabled?: boolean } {
  if (recordingProcess) {
    return { ok: false, message: "Recording already started (stop it first)" };
  }
  lastRecordingError = null;
  recordingStartTime = Date.now();
  weStartedRecording = true;
  setRecordingStartTime(new Date(recordingStartTime).toISOString()).catch(() => {});
  const cliPath = getScreenpipeCliPath();
  if (!cliPath) {
    lastRecordingError = "screenpipe package not found. Run: npm install";
    return { ok: false, message: lastRecordingError };
  }
  const deepgramKey = options?.deepgramApiKey?.trim() || process.env.DEEPGRAM_API_KEY;
  const enableRealtime = Boolean(deepgramKey);
  const env = { ...process.env, ...(deepgramKey ? { DEEPGRAM_API_KEY: deepgramKey } : {}) };
  const args: string[] = enableRealtime && deepgramKey
    ? [cliPath, "record", "--enable-realtime-audio-transcription", "--deepgram-api-key", deepgramKey, "--enable-ui-events"]
    : [cliPath, "record", "--enable-ui-events"];
  try {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
      env,
      cwd: process.cwd(),
    }) as ChildProcess & { stderr: NodeJS.ReadableStream | null; on: (event: string, listener: (...args: unknown[]) => void) => void; unref?: () => void };
    recordingProcess = child;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer | string) => (stderr += d.toString()));
    const startAt = Date.now();
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      recordingProcess = null;
      if (code !== 0 && code !== null) {
        lastRecordingError = stderr.trim() || `Process exited with code ${code}`;
      } else if (Date.now() - startAt < 15000 && stderr.trim()) {
        const benign =
          /file descriptor limit already sufficient|increased file descriptor limit/i.test(stderr);
        if (!benign) lastRecordingError = stderr.trim();
      }
    });
    child.unref?.();
    const message = enableRealtime
      ? "Recording started with speech transcription. Wait for 'Recording active' and 'Microphone: recording speech' below."
      : "Recording started. Wait for 'Recording active' below. (Save a Deepgram key to include your speech in the doc.)";
    return { ok: true, message, speechEnabled: enableRealtime };
  } catch (e) {
    recordingProcess = null;
    recordingStartTime = null;
    lastRecordingError = e instanceof Error ? e.message : "Failed to start";
    return { ok: false, message: lastRecordingError };
  }
}

function stopRecording(): { ok: boolean; message: string } {
  setRecordingEndTime(new Date().toISOString()).catch(() => {});
  if (!recordingProcess) {
    weStartedRecording = false;
    if (lastRecordingError) {
      return {
        ok: false,
        message:
          "No recording process is running. Start failed earlier: " +
          lastRecordingError.slice(0, 180) +
          ". Run in a terminal: npx screenpipe record",
      };
    }
    return {
      ok: true,
      message:
        "Recording end time saved. Click Download to generate docs (Screenpipe must stay running). When done, stop Screenpipe in a terminal: pkill -f screenpipe",
    };
  }
  recordingProcess = null;
  weStartedRecording = false;
  return {
    ok: true,
    message:
      "Recording end time saved. Click Download now to generate docs. Screenpipe is still running so Download can fetch data. When done: pkill -f screenpipe",
  };
}

/** Kill any Screenpipe process (ours or from terminal) and clear recording state. */
async function startOver(): Promise<{ ok: boolean; message: string }> {
  if (recordingProcess) {
    try {
      recordingProcess.kill("SIGTERM");
    } catch {
      // ignore
    }
    recordingProcess = null;
  }
  recordingStartTime = null;
  lastRecordingError = null;
  weStartedRecording = false;
  await clearRecordingState();

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/IM", "screenpipe.exe"], { stdio: "ignore" });
    } catch {
      // ignore
    }
  } else {
    try {
      spawn("pkill", ["-f", "screenpipe"], { stdio: "ignore" });
    } catch {
      // ignore
    }
  }

  return { ok: true, message: "Screenpipe stopped. Ready for a new recording." };
}

function readBody(req: import("http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: import("http").ServerResponse, data: object, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendHtml(res: import("http").ServerResponse, html: string) {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

function sendNotFound(res: import("http").ServerResponse) {
  res.writeHead(404);
  res.end("Not found");
}

/** Generate docs and return as downloadable file (zip for markdown, single file for docx). */
async function handleDownload(
  res: import("http").ServerResponse,
  format: "markdown" | "docx",
  productName: string,
  hoursBack: number,
  appName?: string,
  windowName?: string
) {
  const recordingRange = await getRecordingTimeRange();
  const startTime = recordingRange
    ? recordingRange.startTime
    : new Date((recordingStartTime ?? Date.now() - hoursBack * 60 * 60 * 1000)).toISOString();
  let endTime = recordingRange ? recordingRange.endTime : new Date().toISOString();
  // Extend end time by 90s so late-arriving transcriptions (Deepgram streaming) are included
  const endMs = new Date(endTime).getTime() + 90 * 1000;
  const endTimeWithBuffer = new Date(endMs).toISOString();

  // Screenshot frames can take 20–30s to become available after Stop. If recording ended very recently, wait so frames are ready.
  const RECENT_STOP_WINDOW_MS = 70 * 1000;
  const WAIT_FOR_FRAMES_MS = 22 * 1000;
  const endTimeMs = new Date(endTime).getTime();
  const nowMs = Date.now();
  if (recordingRange?.endTime && nowMs - endTimeMs < RECENT_STOP_WINDOW_MS && nowMs - endTimeMs >= 0) {
    const waitMs = Math.min(WAIT_FOR_FRAMES_MS, Math.max(0, WAIT_FOR_FRAMES_MS - (nowMs - endTimeMs)));
    if (waitMs > 500) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  const apiKey = await getOpenAiApiKey();
  if (!apiKey) {
    sendJson(res, { error: "OpenAI API key not set. Save your key in Settings in the Documate UI." }, 400);
    return;
  }

  let tmpDir: string | null = null;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "doc-from-usage-"));
    let events;
    try {
      events = await fetchUsageEvents({
        baseUrl: SCREENPIPE_API,
        startTime,
        endTime: endTimeWithBuffer,
        limit: 500,
        appName: appName || undefined,
        windowName: windowName || undefined,
        includeFrames: true,
      });
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        sendJson(res, { error: "Screenpipe is not running. Click Start recording in Documate and wait for 'Recording active', then try Download again." }, 503);
        return;
      }
      throw fetchErr;
    }
    if (events.length === 0) {
      sendJson(res, {
        error:
          "No usage data in this time range. Make sure you: 1) Click Start recording and wait for 'Recording active'. 2) Use your product (open the app, click around, use features). 3) Then click Download. Optionally filter by the exact app name (e.g. your app or 'Chrome').",
      }, 400);
      return;
    }
    const { contexts: screenshotContexts } = getScreenshotContexts(events);
    const rawTracePayload = buildRawTracePayload({
      events,
      productName,
      screenshotContexts: screenshotContexts.length > 0 ? screenshotContexts : undefined,
    });
    if (process.env.DOC_FROM_USAGE_SAVE_RAW_TRACE === "1") {
      const traceDir = join(homedir(), ".doc-from-usage");
      await mkdir(traceDir, { recursive: true }).catch(() => {});
      await writeFile(join(traceDir, "last-raw-trace.txt"), rawTracePayload, "utf-8").catch(() => {});
    }
    let markdownBody = await generateDocumentation({
      events,
      productName,
      openaiApiKey: apiKey,
      model: process.env.DOC_FROM_USAGE_MODEL,
      screenshotContexts: screenshotContexts.length > 0 ? screenshotContexts : undefined,
    });
    const audioCountForNote = events.filter((e) => e.type === "audio").length;
    const inputCountForNote = events.filter((e) => e.type === "input").length;
    if (audioCountForNote === 0) {
      markdownBody +=
        "\n\n---\n\n**Note:** No spoken narration was recorded in this trace. The capture may include a separate local page (Documate) with instructions, but no speech was transcribed. If you re-record with audio transcription enabled (save your Deepgram API key in the Documate Settings, then Start recording), your narration (e.g., “I’m clicking Create ticket to start a new ticket”) can be quoted directly in these guides.";
    }
    if (inputCountForNote === 0) {
      markdownBody +=
        "\n\n---\n\n**Note:** No click or scroll events were recorded. Grant **Input Monitoring** (and Accessibility) to **Node** or **Terminal** in System Settings → Privacy & Security, then start a new recording.";
    }
    const result = await writeDocsToFolder({
      outputFolder: tmpDir,
      outputFormat: format,
      productName,
      markdownBody,
      startTime,
      endTime,
      events,
      baseUrl: SCREENPIPE_API,
    });

    const safeName = productName.replace(/[^a-zA-Z0-9-_]/g, "-");
    const dateStr = new Date().toISOString().slice(0, 10);

    const ocrCount = events.filter((e) => e.type === "ocr").length;
    const inputCount = events.filter((e) => e.type === "input").length;
    const audioCount = events.filter((e) => e.type === "audio").length;
    const eventCountHeader = {
      "X-Event-Count": String(events.length),
      "X-OCR-Count": String(ocrCount),
      "X-Input-Count": String(inputCount),
      "X-Audio-Count": String(audioCount),
      "X-Screenshot-Count": String(result.imagesCount),
    };
    if (format === "docx") {
      const buf = await readFile(result.path);
      res.writeHead(200, {
        ...eventCountHeader,
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${safeName}-${dateStr}.docx"`,
        "Content-Length": buf.length,
      });
      res.end(buf);
    } else {
      const zipFilename = `${safeName}-${dateStr}.zip`;
      res.writeHead(200, {
        ...eventCountHeader,
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipFilename}"`,
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
      } catch {}
    }
  }
}

const server = createServer(async (req, res) => {
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
      recordingError: lastRecordingError ?? undefined,
      startedButExited: weStartedRecording && !recordingProcess,
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
  if (url.pathname === "/api/recording/start-over" && req.method === "POST") {
    const result = await startOver();
    sendJson(res, result);
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
      if (now - endMs > 2 * 60 * 1000) {
        sendJson(res, { ready: true });
        return;
      }
      const startTime = range.startTime;
      const endTimeWithBuffer = new Date(endMs + 90 * 1000).toISOString();
      const searchUrl = `${SCREENPIPE_API.replace(/\/$/, "")}/search?content_type=ocr&start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTimeWithBuffer)}&limit=1&offset=0`;
      const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
      if (!searchRes.ok) {
        sendJson(res, { ready: false, total: undefined, message: "Screenpipe search failed" });
        return;
      }
      const searchData = (await searchRes.json()) as { data?: unknown[]; pagination?: { total?: number } };
      const total = searchData.pagination?.total ?? (Array.isArray(searchData.data) ? searchData.data.length : 0);
      sendJson(res, { ready: false, total });
    } catch (e) {
      sendJson(res, { ready: false, total: undefined, message: e instanceof Error ? e.message : "Check failed" });
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
      const startTime = recordingRange
        ? recordingRange.startTime
        : new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      let endTime = recordingRange ? recordingRange.endTime : new Date().toISOString();
      const endMs = new Date(endTime).getTime() + 90 * 1000;
      const endTimeWithBuffer = new Date(endMs).toISOString();
      const appName = url.searchParams.get("appName")?.trim() || undefined;
      const windowName = url.searchParams.get("windowName")?.trim() || undefined;
      const productName = url.searchParams.get("productName")?.trim() || "Product";
      const events = await fetchUsageEvents({
        baseUrl: SCREENPIPE_API,
        startTime,
        endTime: endTimeWithBuffer,
        limit: 500,
        appName,
        windowName,
        includeFrames: false,
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
        screenshotContexts: screenshotContexts.length > 0 ? screenshotContexts : undefined,
      });
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": "inline; filename=raw-trace.txt",
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
      const body = JSON.parse(raw || "{}") as {
        format?: "markdown" | "docx";
        productName?: string;
        hours?: number;
        appName?: string;
        windowName?: string;
      };
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
      hasDeepgramKey: Boolean(config.deepgramApiKey),
    });
    return;
  }
  if (url.pathname === "/api/settings" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as { openaiApiKey?: string; deepgramApiKey?: string };
      const updates: { openaiApiKey?: string; deepgramApiKey?: string } = {};
      if (body.openaiApiKey !== undefined) updates.openaiApiKey = body.openaiApiKey || undefined;
      if (body.deepgramApiKey !== undefined) updates.deepgramApiKey = body.deepgramApiKey || undefined;
      await saveConfig(updates);
      sendJson(res, { ok: true });
    } catch {
      sendJson(res, { ok: false }, 400);
    }
    return;
  }

  sendNotFound(res);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
    console.error(`Either stop the other process using port ${PORT}, or run with a different port:`);
    console.error(`  DOC_FROM_USAGE_PORT=3041 npm run ui`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const hostDisplay = HOST === "0.0.0.0" ? "0.0.0.0" : "localhost";
  console.log(`Documate: http://${hostDisplay}:${PORT}`);
  if (HOST === "0.0.0.0") {
    console.log(`  (Others on your network: http://<this-machine-ip>:${PORT})`);
  }
  console.log(`Screenpipe API:  ${SCREENPIPE_API}`);
});
