import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { OutputFormat } from "./types.js";

const CONFIG_DIR = process.env.DOC_FROM_USAGE_CONFIG_DIR ?? join(homedir(), ".doc-from-usage");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface SavedConfig {
  openaiApiKey?: string;
  /** Deepgram API key for realtime speech transcription (saved locally; enables speech in docs when Start recording is used). */
  deepgramApiKey?: string;
  screenpipeRecordCommand?: string;
  /** Folder path for documentation output (e.g. ~/Documents/MyProduct/docs) */
  outputFolder?: string;
  /** Output format: markdown (recommended) or docx */
  outputFormat?: OutputFormat;
}

let cached: SavedConfig | null = null;

export async function loadConfig(): Promise<SavedConfig> {
  if (cached) return cached;
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    cached = JSON.parse(raw) as SavedConfig;
    return cached ?? {};
  } catch {
    cached = {};
    return {};
  }
}

export async function saveConfig(updates: Partial<SavedConfig>): Promise<SavedConfig> {
  const current = await loadConfig();
  const next = { ...current, ...updates };
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  cached = next;
  return next;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

/** Get OpenAI API key from env or saved config (for use in generate). */
export async function getOpenAiApiKey(): Promise<string | undefined> {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const config = await loadConfig();
  return config.openaiApiKey;
}

/** Get Deepgram API key from env or saved config (for realtime transcription when starting recording). */
export async function getDeepgramApiKey(): Promise<string | undefined> {
  if (process.env.DEEPGRAM_API_KEY) return process.env.DEEPGRAM_API_KEY;
  const config = await loadConfig();
  return config.deepgramApiKey;
}
