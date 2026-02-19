/**
 * Stores sessions on disk (JSON files under a data dir). Optional SQLite can be added later.
 */
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import type { Session } from "../core-types.js";

const SESSIONS_DIR = "sessions";
const INDEX_FILE = "index.json";

export interface SessionStoreOptions {
  baseDir: string;
}

export function getSessionsDir(baseDir: string): string {
  return join(baseDir, SESSIONS_DIR);
}

export async function ensureStore(baseDir: string): Promise<void> {
  await mkdir(getSessionsDir(baseDir), { recursive: true });
}

export async function saveSession(session: Session, baseDir: string): Promise<void> {
  await ensureStore(baseDir);
  const path = join(getSessionsDir(baseDir), `${session.id}.json`);
  await writeFile(path, JSON.stringify(session, null, 0), "utf-8");
  const indexPath = join(getSessionsDir(baseDir), INDEX_FILE);
  let index: { ids: string[] } = { ids: [] };
  try {
    const raw = await readFile(indexPath, "utf-8");
    index = JSON.parse(raw);
  } catch {
    // no index yet
  }
  if (!index.ids.includes(session.id)) {
    index.ids.push(session.id);
    index.ids.sort();
    await writeFile(indexPath, JSON.stringify(index, null, 0), "utf-8");
  }
}

export async function loadSession(sessionId: string, baseDir: string): Promise<Session | null> {
  const path = join(getSessionsDir(baseDir), `${sessionId}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export async function listSessionIds(baseDir: string): Promise<string[]> {
  const indexPath = join(getSessionsDir(baseDir), INDEX_FILE);
  try {
    const raw = await readFile(indexPath, "utf-8");
    const index = JSON.parse(raw) as { ids: string[] };
    return index.ids ?? [];
  } catch {
    return [];
  }
}

export async function listSessions(baseDir: string): Promise<Session[]> {
  const ids = await listSessionIds(baseDir);
  const sessions: Session[] = [];
  for (const id of ids) {
    const s = await loadSession(id, baseDir);
    if (s) sessions.push(s);
  }
  return sessions.sort((a, b) => b.startTime.localeCompare(a.startTime));
}
