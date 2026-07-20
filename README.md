# Documate

Record yourself using a product. Get a written guide (Markdown or Word) with screenshots.

Documate starts [Screenpipe](https://github.com/screenpipe/screenpipe) for you, captures what you do on screen (and optionally what you say), then asks Claude on **AWS Bedrock** to write the docs. Raw screen data stays on your machine; only a condensed text trace goes to the LLM.

---

## How to use it (web UI)

This is the normal way to run Documate.

### 1. One-time setup

```bash
npm install
```

You need:

- **Node.js 18+**
- **AWS credentials** that can call Bedrock (Claude). Documate does **not** use an Anthropic or OpenAI API key. Use `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, `AWS_PROFILE`, or `~/.aws/credentials`, and enable the Claude models in Bedrock for your region.

```bash
export AWS_REGION=us-east-1
# credentials via env, AWS_PROFILE, or ~/.aws/credentials
```

If `@screenpipe/js` is linked from source in this monorepo, build it once:

```bash
cd packages/screenpipe-js/node-sdk && npm run build
```

**macOS:** the first time you record, grant **Screen Recording** and **Input Monitoring** (and **Microphone** if you use speech) to **Node** or **Terminal**. Without those, recordings come back empty.

### 2. Start the UI

```bash
npm run ui
```

Open **http://localhost:3040**.

### 3. Record → generate → download

1. *(Optional)* Open **Settings**: set AWS region / Bedrock model, and choose speech (**Whisper** = local default, **Deepgram** = cloud + API key, or **Off**).
2. On the main page, set **Product name**, optional **App filter** (e.g. Chrome only), and **Format** (Markdown ZIP or Word `.docx`).
3. Click **Start recording** and wait until status says **Recording active**.
4. Use the product you want documented (click through the flow; narrate out loud if speech is enabled).
5. Click **Stop recording**. This marks the end of the session but **keeps Screenpipe running** so generation can read the data.
6. Click **Download documentation**. Wait if needed — screenshots can take ~20–30s after stop. The file downloads in the browser (nothing is written to a folder automatically).
7. When done, click **Start over** to stop Screenpipe and reset.

That’s the whole loop.

---

## Command line

Same idea without a browser. Build once, then record and generate as separate steps. **Order matters:** generate while Screenpipe is still running; kill it only after.

```bash
npm install && npm run build

npm run record              # 1. start Screenpipe — wait for "Recording started"
# ... use your product ...
npm run record:stop         # 2. mark end time (Screenpipe stays up)
npm run generate -- --out ./docs.md   # 3. generate while Screenpipe is still running
npm run record:kill         # 4. stop Screenpipe when finished
```

Other useful generate forms:

```bash
# Folder with screenshots, one app only
npm run generate -- --output-folder ./my-docs --format markdown --app "Chrome" --product "My App"

# No prior record/stop — use the last N hours of Screenpipe data instead
npm run generate -- --out ./docs.md --hours 2
```

### Generate options

| Option | Description |
|--------|-------------|
| `--out <path>` | Single Markdown file (no screenshots). |
| `--output-folder <dir>` | Folder: dated `.md` + `images/`, or a `.docx`. |
| `--format markdown\|docx` | With `--output-folder`. Default: `markdown`. |
| `--app <name>` | Only this app (e.g. `Chrome`). |
| `--window <title>` | Only windows whose title contains this text. |
| `--hours <N>` | Look-back if you didn’t record (default: 2). |
| `--start <ISO>` / `--end <ISO>` | Explicit time range instead of `--hours`. |
| `--product <name>` | Product name in the doc title (defaults to `--app`). |
| `--api <url>` | Screenpipe API (default `http://localhost:3030`). |
| `--limit <N>` | Max events per content type (default: 100). |

`node dist/cli.js --help` prints the same list.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or `AWS_PROFILE`) | — | **Required** for Bedrock. |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | `us-east-1` | Bedrock region (also settable in the UI). |
| `DOC_FROM_USAGE_MODEL` | `us.anthropic.claude-sonnet-5` | Bedrock Claude model ID. |
| `DOC_FROM_USAGE_ENRICH_MODEL` | `us.anthropic.claude-haiku-4-5` | Model for step enrichment. |
| `DOC_FROM_USAGE_TRANSCRIPTION` | `whisper` | `whisper`, `deepgram`, or `off`. |
| `DEEPGRAM_API_KEY` | — | Only if transcription is `deepgram`. |
| `DOC_FROM_USAGE_PORT` | `3040` | Web UI port. |
| `DOC_FROM_USAGE_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN access). |
| `SCREENPIPE_API` | `http://localhost:3030` | Screenpipe API URL. |

UI settings are also saved under `~/.doc-from-usage/config.json`.

```bash
DOC_FROM_USAGE_PORT=3050 npm run ui
DOC_FROM_USAGE_HOST=0.0.0.0 npm run ui   # then open http://<your-ip>:3040
```

Recording still runs on the machine that started the UI; others only drive the browser.

---

## Troubleshooting

**"Screenpipe is not running" / connection refused**  
Start recording first and wait for **Recording active**. On the CLI, run `npm run record` and keep Screenpipe up through `generate`.

**Empty doc / "No events in this time range"**  
- Generate **before** killing Screenpipe (`Stop` / `record:stop` do not kill it; `Start over` / `record:kill` do).  
- Record again and actually use the app, or widen `--hours`.  
- Clear the app filter if the name didn’t match.  
- macOS: confirm Screen Recording + Input Monitoring for Node/Terminal.  
- Sanity check: `curl http://localhost:3030/health` and `curl "http://localhost:3030/search?content_type=ocr&limit=5"`.

**No speech in the doc**  
Transcription isn’t **Off**, Microphone is allowed, and (for Deepgram) the API key is saved. Otherwise Documate falls back to local Whisper.

**Port already in use**  
`DOC_FROM_USAGE_PORT=3041 npm run ui`

**`npx screenpipe@latest record` → "screenpipe: command not found"**  
Use Documate’s recorder instead: `npm run record` (runs Screenpipe via Node from this package).

---

## How it works (short)

1. **Capture** — Screenpipe records OCR + input (and audio if enabled) locally.  
2. **Fetch** — Documate queries those events for your time range / app filter.  
3. **Generate** — Claude on Bedrock turns the trace into a guide.  
4. **Assemble** — screenshots are attached; you get Markdown or `.docx`.

---

## Advanced

### Programmatic pipeline

For more structured click-by-click step docs (title, instruction, tips, hotspot screenshots):

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

| Module | Path | Purpose |
|--------|------|---------|
| Session import | `src/session/` | Fetch, group, store sessions |
| Workflow detection | `src/workflow/detect-steps.ts` | Events → `WorkflowStep[]` |
| Screenshot rendering | `src/screenshot/render-step.ts` | Frame + hotspot → PNG |
| AI doc from steps | `src/doc-from-steps/` | Steps → written guide |
| Pipeline | `src/pipeline.ts` | Orchestrates the above |

### Screenpipe Pipe

In the Screenpipe desktop app, open **Pipes** and run **doc-from-usage**. Configure `product_app_name`, `product_window_name`, and `output_path` in the pipe settings if needed.
