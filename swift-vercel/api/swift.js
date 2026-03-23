// api/swift.js — Vercel Serverless Function (v5: Ultra-Selective Extraction)
// Vercel Free has a ~100MB soft-limit for writes. We must stay under it.

const { spawnSync } = require("child_process");
const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const https  = require("https");
const http   = require("http");
const zlib   = require("zlib");

const SWIFT_VERSION = "5.10.1";
const SWIFT_DIR     = `/tmp/swift-${SWIFT_VERSION}`;
const SWIFTC_BIN    = `${SWIFT_DIR}/usr/bin/swiftc`;
const SWIFT_URL =
  `https://download.swift.org/swift-${SWIFT_VERSION}-release/ubuntu2204/swift-${SWIFT_VERSION}-RELEASE/` +
  `swift-${SWIFT_VERSION}-RELEASE-ubuntu22.04.tar.gz`;

function log(msg) {
  console.log(`[swift-api] ${new Date().toISOString()} ${msg}`);
}

function sh(cmd, timeoutMs = 120_000) {
  const result = spawnSync("/bin/bash", ["-c", cmd], {
    maxBuffer: 32 * 1024 * 1024,
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

async function downloadSwiftMinimal() {
  log("Downloading Swift runtime (minimal native tar)...");
  cleanup(true);
  
  try {
    // Use native tar with --wildcards to extract ONLY what we need in one pass
    const cmd = `
      cd /tmp && \
      timeout 300 curl -fsSL "${SWIFT_URL}" 2>/dev/null | \
      tar xzf - --strip-components=1 \
        -C /tmp \
        --wildcards \
        --exclude='*.a' \
        --exclude='*.swiftmodule' \
        --exclude='*.swiftdoc' \
        --exclude='*test*' \
        --exclude='*doc*' \
        'swift-*/usr/bin/swiftc' \
        'swift-*/usr/bin/swift-frontend' \
        'swift-*/usr/lib/swift/linux/x86_64/libswift*.so*' \
        2>&1 | head -10
    `;
    
    mkdirpSync(SWIFT_DIR);
    const result = sh(cmd, 300_000);
    
    if (!fs.existsSync(SWIFTC_BIN)) {
      throw new Error("Failed to extract swiftc. Check network/permissions.");
    }
    
    fs.chmodSync(SWIFTC_BIN, 0o755);
    log("✓ Swift ready via native tar filtering");
  } catch (e) {
    sh(`rm -rf "${SWIFT_DIR}"`);
    throw e;
  }
}

async function ensureSwift() {
  if (!isSwiftInstalled()) await downloadSwiftMinimal();
}

async function runSwift(code, action = "run", args = []) {
  await ensureSwift();
  const hash = crypto.createHash("sha1").update(code + action).digest("hex").slice(0, 10);
  const workDir = `/tmp/sw-${hash}`;
  cleanup();
  fs.mkdirSync(workDir, { recursive: true });
  const srcFile = path.join(workDir, "main.swift");
  fs.writeFileSync(srcFile, code, "utf8");

  const E = `PATH='${SWIFT_DIR}/usr/bin:/usr/bin:/bin' LD_LIBRARY_PATH='${SWIFT_DIR}/usr/lib/swift/linux:${SWIFT_DIR}/usr/lib' HOME='/tmp' TMPDIR='/tmp'`;

  if (action === "run") {
    const binPath = path.join(workDir, "main");
    // Compile with -O to keep binary small
    const compile = sh(`env ${E} "${SWIFTC_BIN}" "${srcFile}" -o "${binPath}" -O 2>&1`, 90_000);
    if (compile.status !== 0) return { success: false, stage: "compile", stderr: compile.stdout };
    const safeArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const run = sh(`env ${E} "${binPath}" ${safeArgs} 2>&1`, 20_000);
    try { sh(`rm -rf "${workDir}"`); } catch (_) {}
    return { success: run.status === 0, stage: "run", stdout: run.stdout, exitCode: run.status };
  } else if (action === "interpret") {
    const safeArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const run = sh(`env ${E} "${SWIFT_DIR}/usr/bin/swift" "${srcFile}" ${safeArgs} 2>&1`, 30_000);
    try { sh(`rm -rf "${workDir}"`); } catch (_) {}
    return { success: run.status === 0, stage: "interpret", stdout: run.stdout, exitCode: run.status };
  }
  return { success: false, stderr: `Unknown action: ${action}` };
}

function cleanup(aggressive = false) {
  try {
    const files = fs.readdirSync("/tmp");
    for (const e of files) {
      if (e.startsWith("sw-") || e.startsWith("main") || e.endsWith(".txt")) {
        try { sh(`rm -rf '/tmp/${e}'`); } catch (_) {}
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
    try { df = " | " + sh("df -h /tmp").stdout.trim().split("\n").pop(); } catch(_) {}
    cleanup(true);
    return res.status(500).json({ success: false, error: err.message + df });
  }
};
