# Swift Cloud — Serverless Swift on Vercel (Free)

Run and compile Swift 5.10.1 code serverlessly, for free, via Vercel.

## How It Works

- Vercel runs a Node.js Lambda function (`api/swift.js`)
- On **cold start**, it downloads Swift 5.10.1 for Ubuntu 22.04 (~170MB compressed) into `/tmp`
- Subsequent **warm** invocations reuse the cached toolchain (fast!)
- Your local `frontend.html` calls the API to compile and run Swift

## ⚠️ Cold Start Warning

First request after a period of inactivity: **30–90 seconds** (downloads Swift).
Subsequent requests: **2–10 seconds** (compile + run).

Vercel free tier keeps functions warm for a few minutes after a request.

---

## Deploy to Vercel (Free)

### Option A — Vercel CLI (recommended)

```bash
npm i -g vercel
cd swift-vercel/
vercel deploy
```

Follow the prompts. When done you'll get a URL like:
`https://swift-serverless-abc123.vercel.app`

### Option B — GitHub + Vercel Dashboard

1. Push this folder to a GitHub repo
2. Go to https://vercel.com/new → Import repo
3. No build settings needed, just deploy

---

## Use the Frontend

1. Open `frontend.html` in your browser (double-click or `open frontend.html`)
2. Paste your Vercel URL into the **API Endpoint** field at the top
3. Write Swift code in the editor
4. Click **Run** or press `Cmd/Ctrl+Enter`

---

## API Reference

### POST `/api/swift`

```json
{
  "code": "print(\"Hello\")",
  "action": "run",
  "args": []
}
```

**Actions:**
- `run` — compile with `swiftc` then execute binary
- `interpret` — run via `swift` interpreter (no compilation)
- `build-package` — build a Swift Package Manager project

**Response:**
```json
{
  "success": true,
  "stage": "run",
  "stdout": "Hello\n",
  "stderr": "",
  "exitCode": 0,
  "elapsed_ms": 3421,
  "swift_version": "5.10.1",
  "cached": true
}
```

### GET `/api/status`

Returns toolchain status and available `/tmp` space.

---

## Vercel Free Tier Limits

| Limit            | Value            |
|------------------|------------------|
| Function timeout | 300s (Pro: 900s) |
| Memory           | 3008 MB          |
| `/tmp` storage   | 512 MB           |
| Invocations/mo   | 100,000          |
| Bandwidth        | 100 GB           |

Swift 5.10.1 extracted size is ~380MB — fits comfortably in 512MB `/tmp`.

---

## Build Modes

| Mode            | Description                          |
|-----------------|--------------------------------------|
| **Run**         | `swiftc` compile → execute           |
| **REPL**        | `swift` interpreter (no compile step)|
| **Pkg**         | `swift build` for Package.swift      |

For **Pkg** mode, send JSON:
```json
{
  "action": "build-package",
  "code": "{\"manifest\": \"// Package.swift ...\", \"sources\": {\"main.swift\": \"...\"}}"
}
```
