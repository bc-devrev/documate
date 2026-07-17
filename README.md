# Documate

**Record your product. Get documentation.**

Documate uses [Screenpipe](https://github.com/screenpipe/screenpipe) to capture screen OCR and input events, then an LLM to turn that usage into markdown or Word docs (overview, step-by-step guides, screenshots).

## Prerequisites

1. **Node.js** (to run Documate: `npm run ui`).
2. **Screenpipe** — started by Documate when you click Start recording, or run it separately with the API on `http://localhost:3030`.
3. **AWS credentials** for Amazon Bedrock (Claude). Configure via `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `AWS_PROFILE`, or `~/.aws/credentials`. Optional: set region in the UI or `AWS_REGION`.

**Permissions (macOS):** Documate runs in **Node** (or **Terminal**). When you click **Start recording**, macOS will prompt for **Screen Recording** and **Input Monitoring** — choose **Node** or **Terminal** and allow. For speech in docs, add a Deepgram key in Settings; when you start recording, allow **Microphone** for Node. No Cursor or special IDE required.

**From this repo:** If `@screenpipe/js` is linked from source, build it first:  
`cd ../../packages/screenpipe-js/node-sdk && npm run build`

**If `npx screenpipe@latest record` gives "sh: screenpipe: command not found"** in Terminal, run Screenpipe via Node from this app instead:
```bash
cd apps/doc-from-usage
npm install   # if you haven't
npm run record
```
This runs `node node_modules/screenpipe/bin/screenpipe.js record` and avoids the npx/shell PATH issue.

## Simple UI (recording + Bedrock)

Run the local UI to **start/stop recording** and configure **AWS region / Bedrock model** (credentials come from your AWS env or profile):

```bash
cd apps/doc-from-usage
npm run ui
```

Then open **http://localhost:3040** in your browser. You can:

- **Output folder** – choose where documentation is saved. You can add your own images and edit the files there. If you click **Start recording** without a folder set, we’ll ask you for it.
- **Format** – **Markdown** (recommended for product docs): a `.md` file plus an `images/` subfolder with screenshots. You get a normal folder you can open in any editor, add images, and keep in git. **Word (.docx)**: one file with text and images, good for sharing with non-devs.
- **Start recording** – runs `npx screenpipe@latest record` in the background.
- **Stop recording** – stops that process.
- **Status** – shows whether Screenpipe is reachable and recording (refreshes every 8s).
- **AWS region / Bedrock model** – optional overrides (stored in `~/.doc-from-usage/config.json`). Claude is invoked via AWS Bedrock using your normal AWS credentials.

To use another port: `DOC_FROM_USAGE_PORT=3050 npm run ui`.

## Let others use it

**Option 1: Others on your network use your running UI**

Bind the server to all interfaces so anyone on the same Wi‑Fi/LAN can open the app in their browser:

```bash
cd apps/doc-from-usage
DOC_FROM_USAGE_HOST=0.0.0.0 npm run ui
```

Then share the URL: `http://<this-machine-ip>:3040` (e.g. `http://192.168.1.10:3040`). Find your IP: `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux).  
Recording and Screenpipe still run on the machine where the UI is running; others just use the browser on that host.

**Option 2: Others run the app on their own machine**

They need Node.js, then:

```bash
git clone <this-repo>
cd apps/doc-from-usage
npm install && npm run build
npm run ui
```

Open http://localhost:3040, set **AWS region** if needed in Settings, and (on macOS) grant **Screen Recording** and **Input Monitoring** when prompted. Ensure AWS credentials can call Bedrock. Optional: **Deepgram API key** for speech in docs.

**Environment variables**

| Variable | Default | Description |
|----------|---------|-------------|
| `DOC_FROM_USAGE_PORT` | 3040 | Port for the UI. |
| `DOC_FROM_USAGE_HOST` | 127.0.0.1 | Bind address. Use `0.0.0.0` to allow network access. |
| `SCREENPIPE_API` | http://localhost:3030 | Screenpipe API URL (same machine as UI when using Start recording). |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | us-east-1 | Bedrock region. Can also be saved in the UI. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | Or use `AWS_PROFILE` / shared credentials. |
| `DOC_FROM_USAGE_MODEL` | `us.anthropic.claude-sonnet-5` | Bedrock Claude model ID. |

## End-to-end runbook (CLI)

**Screenpipe must be running when you generate** (it serves the API). Recommended: let doc-from-usage start it.

```bash
cd apps/doc-from-usage
npm install && npm run build
export AWS_REGION=us-east-1
# ensure AWS credentials are available (env, profile, or ~/.aws/credentials)
```

1. **Start recording** (starts Screenpipe): `npm run record` — wait for "Recording started".
2. **Use your product** (Chrome, etc.); optionally speak ("click this to open a ticket").
3. **Stop** (saves end time; **do not kill Screenpipe**): `npm run record:stop`
4. **Generate** (Screenpipe must still be running): `npm run generate -- --out ./docs.md`
5. **Then** stop Screenpipe: `npm run record:kill` (or `pkill -f screenpipe`).

With screenshots + Chrome only:  
`npm run generate -- --output-folder ./my-docs --app Chrome`

**If you get 0 events:** (1) Run generate **before** killing Screenpipe — `record:stop` no longer kills it. (2) Check API: `curl http://localhost:3030/health`. (3) Check time range: `cat ~/.screenpipe/doc-from-usage-recording.json`. (4) Try without `--app` or use `--hours 2`. (5) macOS: grant Screen Recording, Input Monitoring, Microphone to Node/Terminal.

## Quick start (CLI)

```bash
cd apps/doc-from-usage
npm install && npm run build
export AWS_REGION=us-east-1
# ensure AWS credentials are available (env, profile, or ~/.aws/credentials)
npm run generate -- --out ./docs.md --hours 2
```

- `--app` – Filter by application name (e.g. your app’s name in the taskbar).
- `--window` – Filter by window title substring (e.g. "Dashboard").
- `--hours` – Look back this many hours (default: 2).
- `--start` / `--end` – Or set explicit ISO time range.
- `--out <path>` – Single output file (use this or `--output-folder`).
- `--output-folder <dir>` – Output folder: creates a dated `.md` or `.docx` plus `images/` (for markdown). You can add images and edit there.
- `--format markdown|docx` – Use with `--output-folder`. Default: markdown.
- `--product` – Product name used in the doc title (default: app name).
- `--api` – Screenpipe API base URL (default: `http://localhost:3030`).
- `--limit` – Max search results per content type (default: 100).

## Example

Document the last 4 hours of usage for an app named “Acme” and write to `./docs/acme.md`:

```bash
bun run start -- --app "Acme" --hours 4 --out ./docs/acme.md --product "Acme"
```

Document a specific time range and only windows with “Settings” in the title:

```bash
bun run start -- --app "Chrome" --window "Settings" \
  --start "2025-02-18T09:00:00Z" --end "2025-02-18T12:00:00Z" \
  --out ./docs/settings-flow.md
```

## Environment

| Variable | Description |
|----------|-------------|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` or `AWS_PROFILE` | Required for Bedrock (Claude). |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | Optional. Bedrock region (default: `us-east-1`). |
| `DOC_FROM_USAGE_MODEL` | Optional. Bedrock model ID (default: `us.anthropic.claude-sonnet-5`). |
| `DOC_FROM_USAGE_ENRICH_MODEL` | Optional. Model for step enrichment (default: `us.anthropic.claude-haiku-4-5`). |

## Screenpipe Pipe

You can also run this as a **Screenpipe Pipe** (plugin):

1. Ensure the built-in pipe is installed (it ships with Screenpipe: **doc-from-usage**).
2. In the Screenpipe app, open Pipes and run **doc-from-usage** manually.
3. The pipe prompt tells the AI to query the Screenpipe API for the time range (and optional app/window), then generate docs and write to a file. Configure **product_app_name** / **product_window_name** / **output_path** in the pipe if needed.

## How it works

1. **Fetch** – Calls Screenpipe `GET /search` for `content_type=ocr` and `content_type=input` with your time range and optional `app_name` / `window_name`.
2. **Order** – Sorts all events by timestamp into a single chronological trace.
3. **Generate** – Sends the trace to an LLM with a system prompt to produce markdown: overview, features, step-by-step guides, UI reference.
4. **Write** – Saves to your chosen **output folder**:
   - **Markdown**: creates a dated `.md` file and an `images/` subfolder. Key screenshots from the trace are fetched from Screenpipe and saved as `screen-1.png`, etc., and appended to the doc. You can add more images and edit the markdown.
   - **Word**: creates a single dated `.docx` file with the same content and embedded images.
   - If you don’t set an output folder (e.g. CLI only with `--out`), a single `.md` file is written to the path you give.

All usage data stays local (Screenpipe); only the aggregated trace is sent to the LLM provider.

## Pipeline: sessions, workflow steps, and step-by-step docs

The app includes a **pipeline** that implements:

1. **Session import** – Fetches OCR + input events from the Screenpipe API, groups them into sessions by time window (default 5 min gap), and stores each session (timeline, frames, clicks, keyboard, OCR, metadata) under a configurable data directory.
2. **Workflow detection** – Converts raw events into structured steps (open page, click, enter text, navigate menu, submit form) using heuristics: click + nearby OCR/element name, window/URL change, Enter key, etc. Each step has `stepNumber`, `action`, `target`, `position`, `frameId`, `timestamp`, `contextText`.
3. **Screenshot rendering** – For each step with a `frameId` and `position`, fetches the frame image and draws a hotspot (circle) at the click position; optionally highlights an OCR bounding box.
4. **AI documentation generator** – Converts steps into step-by-step docs: **title**, **instruction**, optional **explanation**, **tips**, **warnings** (one LLM call for the whole list).

### Programmatic usage

```ts
import { runPipeline } from "./src/pipeline.js";
import { writeRenderedStepsToFolder } from "./src/doc-from-steps/write-rendered-docs.js";

const result = await runPipeline({
  baseUrl: "http://localhost:3030",
  startTime: "2025-02-18T10:00:00Z",
  endTime: "2025-02-18T12:00:00Z",
  storeBaseDir: "./data",
  productName: "My App",
  awsRegion: process.env.AWS_REGION,
  renderScreenshots: true,
});

await writeRenderedStepsToFolder({
  outputFolder: "./docs/steps",
  productName: "My App",
  renderedSteps: result.renderedSteps,
});
```

### Module layout

| Module | Path | Purpose |
|--------|------|---------|
| Session import | `src/session/` | `fetch-events.ts`, `group-sessions.ts`, `session-store.ts`, `import-session.ts` |
| Workflow detection | `src/workflow/detect-steps.ts` | Raw events → `WorkflowStep[]` |
| Screenshot rendering | `src/screenshot/render-step.ts` | Frame + hotspot (and optional bbox) → PNG buffer |
| AI doc from steps | `src/doc-from-steps/generate-doc.ts`, `write-rendered-docs.ts` | Steps → title/instruction/explanation/tips/warnings; write to folder |
| Pipeline | `src/pipeline.ts` | Orchestrates import → detect → generate → optional render |
