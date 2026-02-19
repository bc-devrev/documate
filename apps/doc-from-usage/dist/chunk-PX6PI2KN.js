// src/recording.ts
import { spawn } from "child_process";
import { createRequire } from "module";
import { writeFile, readFile, rm, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
var RECORD_DIR = join(homedir(), ".screenpipe");
var RECORDING_JSON = join(RECORD_DIR, "doc-from-usage-recording.json");
async function ensureDir() {
  await mkdir(RECORD_DIR, { recursive: true });
}
function getScreenpipeCliPath() {
  try {
    const require2 = createRequire(import.meta.url);
    return require2.resolve("screenpipe/bin/screenpipe.js");
  } catch {
    return null;
  }
}
async function getRecordingTimeRange() {
  try {
    const raw = await readFile(RECORDING_JSON, "utf-8");
    const data = JSON.parse(raw);
    const start = data.startTime?.trim();
    if (!start) return null;
    const end = data.endTime?.trim();
    return {
      startTime: start,
      endTime: end || (/* @__PURE__ */ new Date()).toISOString()
    };
  } catch {
    return null;
  }
}
async function setRecordingStartTime(startTime) {
  await ensureDir();
  await writeFile(RECORDING_JSON, JSON.stringify({ startTime }), "utf-8").catch(() => {
  });
}
async function setRecordingEndTime(endTime) {
  try {
    const raw = await readFile(RECORDING_JSON, "utf-8");
    const data = JSON.parse(raw);
    await writeFile(
      RECORDING_JSON,
      JSON.stringify({ startTime: data.startTime ?? endTime, endTime }),
      "utf-8"
    ).catch(() => {
    });
  } catch {
    await writeFile(RECORDING_JSON, JSON.stringify({ startTime: endTime, endTime }), "utf-8").catch(() => {
    });
  }
}
async function startRecording() {
  const cliPath = getScreenpipeCliPath();
  if (!cliPath) {
    return { ok: false, message: "screenpipe package not found. Run: npm install" };
  }
  try {
    await ensureDir();
    const child = spawn(process.execPath, [cliPath, "record"], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
      env: process.env,
      cwd: process.cwd()
    });
    const pid = child.pid;
    const startTime = (/* @__PURE__ */ new Date()).toISOString();
    await writeFile(
      RECORDING_JSON,
      JSON.stringify(pid != null ? { startTime, pid } : { startTime }),
      "utf-8"
    ).catch(() => {
    });
    let stderr = "";
    child.stderr?.on("data", (d) => stderr += d.toString());
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) rm(RECORDING_JSON).catch(() => {
      });
    });
    child.unref?.();
    return {
      ok: true,
      message: "Recording started (PID " + pid + "). Use your product, then: npm run record:stop  (saves end time). Then: npm run generate -- --out ./docs.md  (keep Screenpipe running). When done: npm run record:kill"
    };
  } catch (e) {
    await rm(RECORDING_JSON).catch(() => {
    });
    return { ok: false, message: e instanceof Error ? e.message : "Failed to start" };
  }
}
async function stopRecording() {
  let data;
  try {
    const raw = await readFile(RECORDING_JSON, "utf-8");
    data = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: "No recording started from this CLI (no recording file). To stop Screenpipe: pkill -f screenpipe"
    };
  }
  const endTime = (/* @__PURE__ */ new Date()).toISOString();
  await writeFile(
    RECORDING_JSON,
    JSON.stringify({
      startTime: data.startTime ?? endTime,
      endTime,
      pid: data.pid
    }),
    "utf-8"
  ).catch(() => {
  });
  return {
    ok: true,
    message: "Recording time range saved. Run generate now (Screenpipe must stay running): npm run generate -- --out ./docs.md  When done, stop Screenpipe: pkill -f screenpipe"
  };
}

export {
  getRecordingTimeRange,
  setRecordingStartTime,
  setRecordingEndTime,
  startRecording,
  stopRecording
};
