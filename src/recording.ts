/**
 * Start/stop Screenpipe recording and persist recording start/stop times.
 * Generate step uses this range instead of "last N hours".
 */

import { spawn } from "child_process";
import { createRequire } from "module";
import { writeFile, readFile, rm, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const RECORD_DIR = join(homedir(), ".screenpipe");
const RECORDING_JSON = join(RECORD_DIR, "doc-from-usage-recording.json");

export interface RecordingTimeRange {
  startTime: string;
  endTime: string;
}

async function ensureDir(): Promise<void> {
  await mkdir(RECORD_DIR, { recursive: true });
}

export function getScreenpipeCliPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("screenpipe/bin/screenpipe.js");
  } catch {
    return null;
  }
}

/** Read persisted recording start/stop. If no endTime, use now (recording still running). */
export async function getRecordingTimeRange(): Promise<RecordingTimeRange | null> {
  try {
    const raw = await readFile(RECORDING_JSON, "utf-8");
    const data = JSON.parse(raw) as { startTime?: string; endTime?: string; pid?: number };
    const start = data.startTime?.trim();
    if (!start) return null;
    const end = data.endTime?.trim();
    return {
      startTime: start,
      endTime: end || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Persist recording start time (e.g. when UI starts recording). */
export async function setRecordingStartTime(startTime: string): Promise<void> {
  await ensureDir();
  await writeFile(RECORDING_JSON, JSON.stringify({ startTime }), "utf-8").catch(() => {});
}

/** Persist recording end time (e.g. when UI stops recording). Keeps existing startTime. */
export async function setRecordingEndTime(endTime: string): Promise<void> {
  try {
    const raw = await readFile(RECORDING_JSON, "utf-8");
    const data = JSON.parse(raw) as { startTime?: string };
    await writeFile(
      RECORDING_JSON,
      JSON.stringify({ startTime: data.startTime ?? endTime, endTime }),
      "utf-8"
    ).catch(() => {});
  } catch {
    await writeFile(RECORDING_JSON, JSON.stringify({ startTime: endTime, endTime }), "utf-8").catch(() => {});
  }
}

/** Clear persisted recording range so the next Start is a fresh session. */
export async function clearRecordingState(): Promise<void> {
  await rm(RECORDING_JSON).catch(() => {});
}

export async function startRecording(): Promise<{ ok: boolean; message: string }> {
  const cliPath = getScreenpipeCliPath();
  if (!cliPath) {
    return { ok: false, message: "screenpipe package not found. Run: npm install" };
  }
  try {
    await ensureDir();
    // Omit --enable-realtime-audio-transcription so it works without DEEPGRAM_API_KEY; user can add it if they have a key
    const child = spawn(process.execPath, [cliPath, "record"], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
      env: process.env,
      cwd: process.cwd(),
    });
    const pid = child.pid;
    const startTime = new Date().toISOString();
    await writeFile(
      RECORDING_JSON,
      JSON.stringify(pid != null ? { startTime, pid } : { startTime }),
      "utf-8"
    ).catch(() => {});
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) rm(RECORDING_JSON).catch(() => {});
    });
    child.unref?.();
    return {
      ok: true,
      message:
        "Recording started (PID " +
        pid +
        "). Use your product, then: npm run record:stop  (saves end time). Then: npm run generate -- --out ./docs.md  (keep Screenpipe running). When done: npm run record:kill",
    };
  } catch (e) {
    await rm(RECORDING_JSON).catch(() => {});
    return { ok: false, message: e instanceof Error ? e.message : "Failed to start" };
  }
}

export async function stopRecording(): Promise<{ ok: boolean; message: string }> {
  let data: { startTime?: string; pid?: number };
  try {
    const raw = await readFile(RECORDING_JSON, "utf-8");
    data = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message:
        "No recording started from this CLI (no recording file). To stop Screenpipe: pkill -f screenpipe",
    };
  }
  const endTime = new Date().toISOString();
  await writeFile(
    RECORDING_JSON,
    JSON.stringify({
      startTime: data.startTime ?? endTime,
      endTime,
      pid: data.pid,
    }),
    "utf-8"
  ).catch(() => {});

  return {
    ok: true,
    message:
      "Recording time range saved. Run generate now (Screenpipe must stay running): npm run generate -- --out ./docs.md  When done, stop Screenpipe: pkill -f screenpipe",
  };
}
