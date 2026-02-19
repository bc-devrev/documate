/**
 * Session import: fetch from Screenpipe API, group by time window, store in DB.
 */
import { fetchEventsFromScreenpipe } from "./fetch-events.js";
import { groupEventsIntoSessions } from "./group-sessions.js";
import { ensureStore, saveSession } from "./session-store.js";
import type { Session } from "../core-types.js";

export interface ImportSessionOptions {
  baseUrl: string;
  startTime: string;
  endTime: string;
  appName?: string;
  windowName?: string;
  storeBaseDir: string;
  /** Gap in ms to start a new session (default 5 min). */
  gapMs?: number;
}

export interface ImportSessionResult {
  sessions: Session[];
  eventsFetched: number;
}

export async function importSessions(options: ImportSessionOptions): Promise<ImportSessionResult> {
  const events = await fetchEventsFromScreenpipe({
    baseUrl: options.baseUrl,
    startTime: options.startTime,
    endTime: options.endTime,
    appName: options.appName,
    windowName: options.windowName,
  });

  const sessions = groupEventsIntoSessions(events, { gapMs: options.gapMs });
  await ensureStore(options.storeBaseDir);
  for (const session of sessions) {
    await saveSession(session, options.storeBaseDir);
  }

  return { sessions, eventsFetched: events.length };
}
