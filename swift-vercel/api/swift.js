// api/swift.js — Vercel Serverless Function
// Downloads Swift toolchain to /tmp on cold start, then compiles & runs user code.
// Swift 5.10.1 for Linux x86_64 (~170MB compressed, ~500MB extracted)

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SWIFT_VERSION = "5.10.1";
const SWIFT_PLATFORM = "ubuntu2204";
const SWIFT_ARCH = "x86_64";
const SWIFT_DIR = `/tmp/swift-${SWIFT_VERSION}`;
const SWIFT_BIN = `${SWIFT_DIR}/usr/bin/swift`;
const SWIFT_TAR = `/tmp/swift-${SWIFT_VERSION}.tar.gz`;

// The official Swift download URL
const SWIFT_URL = `https://download.swift.org/swift-${SWIFT_VERSION}-release/${SWIFT_PLATFORM}/${SWIFT_ARCH}/swift-${SWIFT_VERSION}-RELEASE-${SWIFT_PLATFORM}.tar.gz`;

function log(msg) {
  console.log(`[swift-api] ${msg}`);
}

function isSwiftInstalled() {
  return fs.existsSync(SWIFT_BIN);
}

async function downloadSwift() {
  log("Swift not found. Downloading...");
  log(`URL: ${SWIFT_URL}`);

  // Stream download with curl (available in Vercel Lambda environment)
  const dlResult = spawnSync(
    "curl",
    ["-L", "--silent", "--show-error", "-o", SWIFT_TAR, SWIFT_URL],
    { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
  );

  if (dlResult.status !== 0) {
    throw new Error(
      `Download failed: ${dlResult.stderr?.toString() || "unknown error"}`
    );
  }

  const tarSizeMB = fs.statSync(SWIFT_TAR).size / (1024 * 1024);
  log(`Downloaded ${tarSizeMB.toFixed(1)} MB. Extracting...`);

  // Extract to /tmp (strip the top-level directory)
  fs.mkdirSync(SWIFT_DIR, { recursive: true });
  const extractResult = spawnSync(
    "tar",
    ["-xzf", SWIFT_TAR, "-C", SWIFT_DIR, "--strip-components=1"],
    { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
  );

  if (extractResult.status !== 0) {
    throw new Error(
      `Extraction failed: ${extractResult.stderr?.toString() || "unknown error"}`
    );
  }

  // Clean up tarball to save /tmp space
  fs.unlinkSync(SWIFT_TAR);
  log("Swift toolchain ready.");
}

async function runSwift(code, action = "run", args = []) {
  if (!isSwiftInstalled()) {
    await downloadSwift();
  }

  // Write user code to a temp file
  const hash = crypto.createHash("sha1").update(code).digest("hex").slice(0, 8);
  const workDir = `/tmp/swift-work-${hash}`;
  fs.mkdirSync(workDir, { recursive: true });

  const sourceFile = path.join(workDir, "main.swift");
  fs.writeFileSync(sourceFile, code, "utf8");

  const env = {
    ...process.env,
    PATH: `${SWIFT_DIR}/usr/bin:${process.env.PATH}`,
    LD_LIBRARY_PATH: `${SWIFT_DIR}/usr/lib/swift/linux:${SWIFT_DIR}/usr/lib`,
  };

  let result;

  if (action === "run") {
    // Compile + run
    const binaryPath = path.join(workDir, "main");

    // Compile
    const compileResult = spawnSync(
      SWIFT_BIN,
      ["swiftc", sourceFile, "-o", binaryPath],
      {
        env,
        timeout: 60000,
        maxBuffer: 5 * 1024 * 1024,
        cwd: workDir,
      }
    );

    if (compileResult.status !== 0) {
      return {
        success: false,
        stage: "compile",
        stdout: compileResult.stdout?.toString() || "",
        stderr: compileResult.stderr?.toString() || "",
        exitCode: compileResult.status,
      };
    }

    // Run
    const runResult = spawnSync(binaryPath, args, {
      env,
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      cwd: workDir,
    });

    return {
      success: runResult.status === 0,
      stage: "run",
      stdout: runResult.stdout?.toString() || "",
      stderr: runResult.stderr?.toString() || "",
      exitCode: runResult.status,
    };
  } else if (action === "interpret") {
    // swift interpreter mode (no compilation step)
    result = spawnSync(SWIFT_BIN, [sourceFile, ...args], {
      env,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      cwd: workDir,
    });

    return {
      success: result.status === 0,
      stage: "interpret",
      stdout: result.stdout?.toString() || "",
      stderr: result.stderr?.toString() || "",
      exitCode: result.status,
    };
  } else if (action === "build-package") {
    // Build a Swift Package (expects package.json-like manifest + sources in code)
    // For package builds, code is a JSON with { manifest, sources }
    let packageData;
    try {
      packageData = JSON.parse(code);
    } catch {
      return { success: false, stage: "parse", stderr: "Invalid package JSON" };
    }

    // Write Package.swift
    fs.writeFileSync(
      path.join(workDir, "Package.swift"),
      packageData.manifest,
      "utf8"
    );

    // Write sources
    const sourcesDir = path.join(workDir, "Sources", "Main");
    fs.mkdirSync(sourcesDir, { recursive: true });

    for (const [filename, content] of Object.entries(
      packageData.sources || {}
    )) {
      fs.writeFileSync(path.join(sourcesDir, filename), content, "utf8");
    }

    result = spawnSync(SWIFT_BIN, ["build"], {
      env,
      timeout: 120000,
      maxBuffer: 5 * 1024 * 1024,
      cwd: workDir,
    });

    return {
      success: result.status === 0,
      stage: "build-package",
      stdout: result.stdout?.toString() || "",
      stderr: result.stderr?.toString() || "",
      exitCode: result.status,
    };
  }

  return { success: false, stderr: `Unknown action: ${action}` };
}

// Cleanup old work dirs to keep /tmp tidy
function cleanup() {
  try {
    const entries = fs.readdirSync("/tmp");
    const now = Date.now();
    for (const e of entries) {
      if (e.startsWith("swift-work-")) {
        const full = path.join("/tmp", e);
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > 5 * 60 * 1000) {
          execSync(`rm -rf "${full}"`);
        }
      }
    }
  } catch (_) {}
}

module.exports = async function handler(req, res) {
  // CORS headers — allow local frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { code, action = "run", args = [] } = req.body || {};

  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Missing `code` field in body" });
  }

  if (code.length > 50000) {
    return res.status(400).json({ error: "Code too large (max 50KB)" });
  }

  const start = Date.now();
  log(`Request: action=${action}, codeLen=${code.length}`);

  try {
    const result = await runSwift(code, action, args);
    const elapsed = Date.now() - start;
    cleanup();

    return res.status(200).json({
      ...result,
      elapsed_ms: elapsed,
      swift_version: SWIFT_VERSION,
      cached: isSwiftInstalled(),
    });
  } catch (err) {
    log(`Error: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: err.message,
      elapsed_ms: Date.now() - start,
    });
  }
};
