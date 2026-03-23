const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = process.env.HOME || '/root';
const SWIFTLY_BIN = `${HOME}/.local/bin/swiftly`;
const SWIFT_BIN = `${HOME}/.swiftly/toolchains/5.10.1/usr/bin/swift`;

function log(msg) {
  console.log(`[swift] ${msg}`);
}

function sh(cmd, timeout = 300_000) {
  const result = spawnSync("/bin/bash", ["-c", cmd], {
    maxBuffer: 128 * 1024 * 1024,
    timeout,
    env: { ...process.env, HOME }
  });
  return {
    stdout: result.stdout?.toString("utf8") || "",
    stderr: result.stderr?.toString("utf8") || "",
    status: result.status ?? -1,
  };
}

function isSwiftlyInstalled() {
  return fs.existsSync(SWIFTLY_BIN);
}

function isSwiftInstalled() {
  return fs.existsSync(SWIFT_BIN);
}

async function installSwiftly() {
  if (isSwiftlyInstalled()) {
    log("swiftly already installed");
    return true;
  }

  log("Installing swiftly...");
  
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  const version = "1.1.0";
  const url = `https://download.swift.org/swiftly/linux/swiftly-${version}-${arch}.tar.gz`;
  
  const cmd = `
    mkdir -p "${HOME}/.local/bin" && \
    cd /tmp && \
    echo "Downloading swiftly ${version}..." && \
    curl -fSL "${url}" -o swiftly.tar.gz && \
    echo "Extracting..." && \
    tar xzf swiftly.tar.gz && \
    mv swiftly-${version}-${arch}/swiftly "${SWIFTLY_BIN}" && \
    chmod +x "${SWIFTLY_BIN}" && \
    rm -rf swiftly-${version}-${arch} swiftly.tar.gz && \
    echo "Initializing swiftly..." && \
    export PATH="${HOME}/.local/bin:$PATH" && \
    "${SWIFTLY_BIN}" init 2>&1 | tail -10
  `;
  
  const result = sh(cmd, 300_000);
  
  if (!isSwiftlyInstalled()) {
    log("swiftly install failed: " + result.stderr);
    return false;
  }
  
  log("✓ swiftly installed");
  return true;
}

async function installSwift() {
  if (isSwiftInstalled()) {
    log("Swift 5.10.1 already installed");
    return true;
  }

  if (!isSwiftlyInstalled()) {
    if (!await installSwiftly()) {
      throw new Error("Failed to install swiftly");
    }
  }

  log("Installing Swift 5.10.1 via swiftly...");
  
  const cmd = `
    export PATH="${HOME}/.local/bin:$PATH" && \
    export HOME="${HOME}" && \
    "${SWIFTLY_BIN}" install 5.10.1 2>&1 | tail -30
  `;
  
  const result = sh(cmd, 600_000);
  
  if (!isSwiftInstalled()) {
    log("Swift install failed: " + result.stderr);
    return false;
  }
  
  log("✓ Swift 5.10.1 installed");
  return true;
}

async function ensureSwift() {
  try {
    await installSwift();
  } catch (e) {
    log("Swift setup error: " + e.message);
    throw e;
  }
}

async function runSwift(code) {
  await ensureSwift();

  const workDir = `/tmp/swift-run-${Date.now()}`;
  fs.mkdirSync(workDir, { recursive: true });
  const srcFile = path.join(workDir, "main.swift");
  fs.writeFileSync(srcFile, code, "utf8");

  const cmd = `
    export PATH="${HOME}/.swiftly/toolchains/5.10.1/usr/bin:${HOME}/.local/bin:$PATH" && \
    export HOME="${HOME}" && \
    "${SWIFT_BIN}" "${srcFile}" 2>&1
  `;

  const run = sh(cmd, 60_000);

  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}

  return {
    success: run.status === 0,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: "Missing code" });

  try {
    const result = await runSwift(code);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
