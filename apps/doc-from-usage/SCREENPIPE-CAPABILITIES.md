# What Screenpipe Can Give You

Screenpipe captures and exposes the following. The doc-from-usage app uses a subset; you can build more (e.g. cursor-as-hotspot step-by-step) on top of this.

---

## 1. **Screen content (OCR / vision)**

- **What:** Text visible on screen, per window, with timestamps.
- **API:** Search with `contentType: "ocr"`; each result has:
  - `text`, `timestamp`, `appName`, `windowName`, `browserUrl`
  - `frameId` — use this to get a **screenshot** of that moment (`GET /frames/:frame_id`).
- **Use for docs:** “What was on screen when” and “screenshot for this step.”

---

## 2. **Input events (cursor, clicks, keyboard)**

- **What:** User actions: **clicks** (with position), **keyboard** (aggregated text + hotkeys), **scroll**, **app/window focus**, **clipboard**.
- **API:** Search with `contentType: "input"`. Each input event can include:
  - **Cursor / click position:** `x`, `y` (screen or window coordinates).
  - **Click metadata:** `eventType` (e.g. `"click"`), button, click count (single/double).
  - **Element context (when enabled):** `elementRole`, `elementName` — e.g. “AXButton”, “Submit” — so you know *what* was clicked, not just *where*.
- **Config (server):** Clicks are on by default; optional: `capture_mouse_move` (throttled), `capture_context` (accessibility element at click position).

So Screenpipe **can** give you “where the cursor was” and “what was clicked” (position + optional element name/role), which is exactly what you need for **cursor-as-hotspot step-by-step** (e.g. “Step 2: Click the **Submit** button” or “Click at (320, 140) in the toolbar”).

---

## 3. **Frames (screenshots)**

- **What:** Image for a given `frameId` at a given time.
- **API:** `GET /frames/:frame_id` (returns image). Optional: `GET /frames/:frame_id/ocr` for text positions with **bounding boxes** (left, top, width, height).
- **Use for docs:** Illustrate steps with screenshots; optionally draw click/cursor hotspots using `(x, y)` from input events.

---

## 4. **Keyword search with positions**

- **What:** Search for text and get **where** it appears (frame + bounding box).
- **API:** `GET /search/keyword?query=...` returns `frameId`, `textPositions[]` with `text`, `bounds` (left, top, width, height).
- **Use for docs:** “Click where it says ‘Save’” or highlight regions in a screenshot.

---

## 5. **Audio (transcriptions)**

- **What:** Speech-to-text from system/device audio (when enabled).
- **API:** Search with `contentType: "audio"`; results include `transcription`, `timestamp`, speaker, etc.
- **Use for docs:** “User said X” or voice-driven flows.

---

## Summary for “cursor as hotspot” step-by-step

| You want | Screenpipe gives you |
|----------|----------------------|
| Where the user clicked | Input events with `x`, `y` |
| What they clicked (e.g. “Submit”) | Input events with `elementName` / `elementRole` when capture_context is on |
| Screenshot for that moment | `frameId` from OCR or from the frame at that time → `GET /frames/:frame_id` |
| “Click at this spot” in the doc | Use `(x, y)` to draw a hotspot on the frame image, or describe “Click the [elementName] button” |

The **doc-from-usage** app currently passes only high-level input events (event type, app, window, text) to the LLM, not `x`, `y`, or `elementName`/`elementRole`. To get **step-by-step that uses the cursor as the hotspot** (e.g. “Click the **Save** button” or “Click here [screenshot with marker]”), the next steps are:

1. **Include in the trace:** For each input event, add `x`, `y`, `elementName`, `elementRole` to the usage events and to the text you send to the LLM.
2. **Optionally add screenshots:** For each “click” (or key moment), fetch the frame at that time and attach it to the step (e.g. as an image in the markdown or as a reference).
3. **Prompt the LLM** to write steps like “Click the [elementName] button” or “Click at (x, y) in the toolbar” and to reference the screenshot for that step.

If you want, we can wire (1) and (2) into the doc-from-usage pipeline and adjust the prompt so the generated doc uses cursor/click position and optional screenshots for step-by-step.
