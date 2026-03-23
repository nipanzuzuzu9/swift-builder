// api/swift.js — Vercel Serverless Function (v8: GitHub-hosted minimal runtime)
// Uses a pre-built minimal Swift runtime hosted on GitHub to bypass network restrictions

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const SWIFT_VERSION = "5.10.1";
const SWIFT_DIR = `/tmp/swift-${SWIFT_VERSION}`;
const SWIFTC_BIN = `${SWIFT_DIR}/usr/bin/swiftc`;

// Minimal Swift runtime hosted on GitHub (you'll need to create this, but for now use a fallback)
const SWIFT_RUNTIME_URL = "https://github.com/user/swift-minimal-runtime/releases/download/v5.10.1/swift-minimal-5.10.1.tar.gz";

// FALLBACK: Use system swift if available, or compile with downloaded musl-based swift
const FALLBACK_SWIFT_URLS = [
  "https://raw.githubusercontent.com/swift-docker/swift/main/5.10.1/ubuntu22.04/Dockerfile",
];

function log(msg) {
  console.log(`[swift-api] ${new Date().toISOString()} ${msg}`);
}

function sh(cmd, timeoutMs = 120_000) {
  const result = spawnSync("/bin/bash", ["-c", cmd], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    stdout: result.stdout?.toString("utf8") || "",
    stderr: result.stderr?.toString("utf8") || "",
    status: result.status ?? -1,
  };
}

function isSwiftInstalled() {
  return fs.existsSync(SWIFTC_BIN);
}

function mkdirpSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Use system swift as fallback
function useSystemSwift() {
  const systemSwift = sh("which swiftc").stdout.trim();
  if (systemSwift) {
    log(`Using system swift from: ${systemSwift}`);
    fs.mkdirSync(SWIFT_DIR + "/usr/bin", { recursive: true });
    sh(`ln -sf ${systemSwift} ${SWIFTC_BIN}`);
    return true;
  }
  return false;
}

// Check if swift is available in the base image
async function checkBaseImageSwift() {
  const test = sh("swiftc --version");
  if (test.status === 0) {
    log("✓ Swift found in base image!");
    useSystemSwift();
    return true;
  }
  return false;
}

async function downloadSwiftMinimal() {
  log("Attempting to download minimal Swift runtime...");
  cleanup(true);

  // Try GitHub first
  try {
    const cmd = `
      mkdir -p "${SWIFT_DIR}" && \
      cd /tmp && \
      timeout 240 curl -fsSL "${SWIFT_RUNTIME_URL}" 2>&1 | \
      tar xzf - -C "${SWIFT_DIR}" --strip-components=1 && \
      chmod +x "${SWIFTC_BIN}" && \
      ls -lah "${SWIFTC_BIN}"
    `;
    
    const result = sh(cmd, 300_000);
    if (fs.existsSync(SWIFTC_BIN)) {
      log("✓ Downloaded Swift from GitHub release");
      return true;
    }
    log("GitHub download failed, trying fallback...");
  } catch (e) {
    log("GitHub download error: " + e.message);
  }

  // Fallback to system swift
  if (await checkBaseImageSwift()) {
    return true;
  }

  // Last resort: try to build a minimal swift from source (extremely slow)
  log("⚠ No pre-built Swift available. This will be slow...");
  throw new Error(
    "Swift not available. Set SWIFT_RUNTIME_URL to a GitHub release with minimal Swift runtime."
  );
}

async function ensureSwift() {
  if (isSwiftInstalled()) return;
  await downloadSwiftMinimal();
  if (!isSwiftInstalled()) {
    throw new Error("Failed to ensure Swift is available");
  }
}

async function runSwift(code, action = "run", args = []) {
  await ensureSwift();
  const hash = crypto
    .createHash("sha1")
    .update(code + action)
    .digest("hex")
    .slice(0, 10);
  const workDir = `/tmp/sw-${hash}`;
  cleanup();
  fs.mkdirSync(workDir, { recursive: true });
  const srcFile = path.join(workDir, "main.swift");
  fs.writeFileSync(srcFile, code, "utf8");

  const E = `PATH='${SWIFT_DIR}/usr/bin:/usr/bin:/bin' LD_LIBRARY_PATH='${SWIFT_DIR}/usr/lib/swift/linux:${SWIFT_DIR}/usr/lib:/usr/lib/x86_64-linux-gnu' HOME='/tmp' TMPDIR='/tmp'`;

  if (action === "run") {
    const binPath = path.join(workDir, "main");
    const compile = sh(
      `env ${E} "${SWIFTC_BIN}" "${srcFile}" -o "${binPath}" -O 2>&1`,
      90_000
    );
    if (compile.status !== 0)
      return { success: false, stage: "compile", stderr: compile.stdout };
    const safeArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const run = sh(`env ${E} "${binPath}" ${safeArgs} 2>&1`, 20_000);
    try {
      sh(`rm -rf "${workDir}"`);
    } catch (_) {}
    return {
      success: run.status === 0,
      stage: "run",
      stdout: run.stdout,
      exitCode: run.status,
    };
  } else if (action === "interpret") {
    const safeArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const run = sh(
      `env ${E} "${SWIFT_DIR}/usr/bin/swift" "${srcFile}" ${safeArgs} 2>&1`,
      30_000
    );
    try {
      sh(`rm -rf "${workDir}"`);
    } catch (_) {}
    return {
      success: run.status === 0,
      stage: "interpret",
      stdout: run.stdout,
      exitCode: run.status,
    };
  }
  return { success: false, stderr: `Unknown action: ${action}` };
}

function cleanup(aggressive = false) {
  try {
    const files = fs.readdirSync("/tmp");
    for (const e of files) {
      if (e.startsWith("sw-")) {
        try {
          sh(`rm -rf '/tmp/${e}'`);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  const { code, action = "run", args = [] } = req.body || {};
  if (!code) return res.status(400).json({ error: "Missing code" });
  try {
    const result = await runSwift(code, action, args);
    return res.status(200).json({ ...result, cached: isSwiftInstalled() });
  } catch (err) {
    let df = "";
    try {
      df = " | " + sh("df -h /tmp").stdout.trim().split("\n").pop();
    } catch (_) {}
    cleanup(true);
    return res
      .status(500)
      .json({ success: false, error: err.message + df });
  }
};
