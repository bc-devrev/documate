/**
 * Groups raw events into sessions by time window (gap threshold).
 */
import type { RawEvent, Session } from "../core-types.js";
import { randomUUID } from "crypto";

const DEFAULT_GAP_MS = 5 * 60 * 1000; // 5 minutes of inactivity = new session

export function groupEventsIntoSessions(
  events: RawEvent[],
  options?: { gapMs?: number }
): Session[] {
  const gapMs = options?.gapMs ?? DEFAULT_GAP_MS;
  if (events.length === 0) return [];

  const sessions: Session[] = [];
  let current: RawEvent[] = [events[0]];
  let startTime = events[0].timestamp;

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    const prevMs = new Date(prev.timestamp).getTime();
    const currMs = new Date(curr.timestamp).getTime();
    if (currMs - prevMs > gapMs) {
      sessions.push(buildSession(randomUUID(), startTime, prev.timestamp, current));
      current = [curr];
      startTime = curr.timestamp;
    } else {
      current.push(curr);
    }
  }
  const last = current[current.length - 1];
  sessions.push(buildSession(randomUUID(), startTime, last.timestamp, current));
  return sessions;
}

function buildSession(id: string, startTime: string, endTime: string, events: RawEvent[]): Session {
  const frameIds = [...new Set(events.filter((e) => e.frameId != null).map((e) => e.frameId!))];
  const last = events[events.length - 1];
  return {
    id,
    startTime,
    endTime,
    activeApp: last?.appName,
    activeWindow: last?.windowName ?? last?.windowTitle,
    activeUrl: last?.url,
    events,
    frameIds,
  };
}
