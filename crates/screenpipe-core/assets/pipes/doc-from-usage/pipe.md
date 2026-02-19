---
schedule: manual
enabled: true
---

AI that watches you use your product and writes documentation automatically.

## Task

1. Use the time range and Screenpipe API URL from the context header.
2. Optionally use the pipe config (see below) for **product_app_name** and **product_window_name** to filter activity to a single app or window (your "product").
3. Query the Screenpipe search API for OCR and input events in that time range (and app/window if set):
   - `GET .../search?content_type=ocr&start_time=<ISO>&end_time=<ISO>&limit=100&app_name=<product_app_name>&window_name=<product_window_name>`
   - `GET .../search?content_type=input&start_time=<ISO>&end_time=<ISO>&limit=100&app_name=...&window_name=...`
4. Build a chronological usage trace: for each result note timestamp, type (screen/action), app, window, and text or event type.
5. Using an LLM (your current model), turn this trace into **product documentation** in markdown:
   - **Overview** – 2–3 sentences on what the product does based on usage.
   - **Features** – Bullet list of features/flows observed (e.g. Login, Settings, Export).
   - **Step-by-step guides** – "How to …" sections with numbered steps inferred from the trace.
   - **UI reference** – Buttons, labels, screens mentioned in the trace.
6. Write the result to the path in **output_path** (default: `~/doc-from-usage/<date>.md`). Create the directory if needed.

## Search API

```
GET http://localhost:3030/search?content_type=ocr|input|all&start_time=<ISO8601>&end_time=<ISO8601>&limit=100&app_name=<string>&window_name=<string>
```

Always include `start_time` and `end_time`. Use `app_name` and/or `window_name` to restrict to the product you are documenting.

## Pipe config (optional)

In pipe.md front-matter or in the pipe folder, you can set:

- **product_app_name** – e.g. "My App" or "Electron" to only document that app.
- **product_window_name** – e.g. "Dashboard" to only include windows whose title contains this.
- **output_path** – e.g. `~/my-product/docs/usage-generated.md`.

If not set, the pipe documents **all** activity in the time range (good for a first run to see everything).

## Output format

Valid markdown. No invented features — only what the trace shows. If the trace is empty, output a short "No usage data in this range" and suggest extending the time range or checking app_name/window_name.

## Rules

- Use the exact time range from the context header.
- Prefer concise, actionable docs. Link to specific screens or flows when the trace supports it.
- Do not make up UI elements or steps that are not suggested by the trace.
