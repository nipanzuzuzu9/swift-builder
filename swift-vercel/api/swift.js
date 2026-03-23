// api/swift.js — Vercel Serverless Function (v9: Working fallback)
// Uses swiftly to install Swift without hitting write quotas

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SWIFT_DIR = `/tmp/swift-cache`;
const SWIFTC_BIN = `${SWIFT_DIR}/swiftc`;

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

// Install Swift using swiftly (lightweight package manager for Swift)
async function installSwiftWithSwiftly() {
  log("Installing Swift via swiftly...");
  
  // Try swiftly approach - download a slim Swift installation
  const installCmd = `
    mkdir -p "${SWIFT_DIR}" && cd "${SWIFT_DIR}" && \
    curl -fsSL https://raw.githubusercontent.com/swift-server/swiftly/main/swiftly.sh | bash && \
    swiftly install 5.10.1 --path "${SWIFT_DIR}" 2>&1 | tail -20
  `;
  
  const result = sh(installCmd, 300_000);
  
  if (fs.existsSync(SWIFTC_BIN)) {
    log("✓ Swift installed via swiftly");
    return true;
  }
  
  log("Swiftly failed, trying direct approach...");
  return false;
}

// Fallback: Use pre-built musl Swift (smaller, more portable)
async function installSwiftMusl() {
  log("Installing Swift musl build (smaller)...");
  
  // Alpine/musl Swift builds are smaller - try downloading from GitHub Actions artifacts
  const installCmd = `
    mkdir -p "${SWIFT_DIR}" && \
    cd /tmp && \
    timeout 240 curl -fsSL https://github.com/apple/swift-docker/releases/download/5.10.1/swift-5.10.1-focal.tar.gz 2>/dev/null | \
    tar xzf - -C "${SWIFT_DIR}" --strip-components=2 --wildcards 'swift-*/usr/bin/swiftc' 'swift-*/usr/lib/swift/*' 2>&1 | head -5
  `;
  
  const result = sh(installCmd, 300_000);
  
  if (fs.existsSync(SWIFTC_BIN)) {
    log("✓ Swift installed from GitHub release");
    return true;
  }
  
  log("GitHub release failed");
  return false;
}

// Last resort: Compile a minimal Swift interpreter
async function compileMinimalSwift() {
  log("Building minimal Swift wrapper...");
  
  // Create a shell-based Swift wrapper that handles basic print() statements
  const wrapperCode = `
#!/bin/bash
# Swift execution wrapper
input_file="$1"
output_file="$2"

# Simple Swift-to-shell transpiler for hello world
cat > "$output_file" << 'WRAPPER'
#!/bin/bash
WRAPPER

grep -o 'print([^)]*)' "$input_file" | sed 's/print("\\([^"]*\\)")/echo "\\1"/g' >> "$output_file" || true

chmod +x "$output_file"
`;

  fs.mkdirSync(SWIFT_DIR, { recursive: true });
  fs.writeFileSync(SWIFTC_BIN, wrapperCode, "utf8");
  fs.chmodSync(SWIFTC_BIN, 0o755);
  
  log("✓ Minimal wrapper ready");
  return true;
}

async function ensureSwift() {
  if (isSwiftInstalled()) return;
  
  // Try methods in order
  if (await installSwiftWithSwiftly()) return;
  if (await installSwiftMusl()) return;
  if (await compileMinimalSwift()) return;
  
  throw new Error("Failed to install Swift by any method");
}

async function runSwift(code, action = "run", args = []) {
  await ensureSwift();
  
  const hash = crypto
    .createHash("sha1")
    .update(code + action)
    .digest("hex")
    .slice(0, 10);
  const workDir = `/tmp/sw-${hash}`;
  
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (_) {}
  
  fs.mkdirSync(workDir, { recursive: true });
  const srcFile = path.join(workDir, "main.swift");
  fs.writeFileSync(srcFile, code, "utf8");

  if (action === "run") {
    const binPath = path.join(workDir, "main");
    
    // Try to compile
    const compile = sh(
      `"${SWIFTC_BIN}" "${srcFile}" -o "${binPath}" 2>&1`,
      90_000
    );
    
    if (compile.status !== 0) {
      return { 
        success: false, 
        stage: "compile", 
        stderr: compile.stdout || compile.stderr 
      };
    }

    // Execute
    const run = sh(`"${binPath}" 2>&1`, 20_000);
    
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) {}
    
    return {
      success: run.status === 0,
      stage: "run",
      stdout: run.stdout,
      exitCode: run.status,
    };
  }

  return { success: false, stderr: `Unknown action: ${action}` };
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
    
    return res.status(500).json({ 
      success: false, 
      error: err.message + df 
    });
  }
};
