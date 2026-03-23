const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function sh(cmd, timeout = 180_000) {
  const result = spawnSync("/bin/bash", ["-c", cmd], {
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    env: { ...process.env, HOME: "/root" }
  });
  return {
    stdout: result.stdout?.toString("utf8") || "",
    stderr: result.stderr?.toString("utf8") || "",
    status: result.status ?? -1,
  };
}

async function ensureSwift() {
  const swiftlyBin = "/root/.local/bin/swiftly";
  const swiftBin = "/root/.swiftly/toolchains/5.10.1/usr/bin/swift";

  // Install swiftly if needed
  if (!fs.existsSync(swiftlyBin)) {
    console.log("Installing swiftly...");
    sh(`
      mkdir -p /root/.local/bin && \
      curl -fsSL https://swift-server.github.io/swiftly/swiftly-install.sh -o /tmp/swiftly-install.sh && \
      chmod +x /tmp/swiftly-install.sh && \
      bash /tmp/swiftly-install.sh --overwrite
    `, 300_000);
  }

  // Install Swift if needed
  if (!fs.existsSync(swiftBin)) {
    console.log("Installing Swift 5.10.1...");
    sh(`
      export PATH="/root/.local/bin:$PATH" && \
      export HOME=/root && \
      swiftly install 5.10.1
    `, 600_000);
  }

  if (!fs.existsSync(swiftBin)) {
    throw new Error("Swift installation failed");
  }
}

async function runSwift(code) {
  await ensureSwift();

  const workDir = `/tmp/swift-run-${Date.now()}`;
  fs.mkdirSync(workDir, { recursive: true });
  const srcFile = path.join(workDir, "main.swift");
  fs.writeFileSync(srcFile, code, "utf8");

  const run = sh(`
    export PATH="/root/.swiftly/toolchains/5.10.1/usr/bin:/root/.local/bin:$PATH" && \
    export HOME=/root && \
    /root/.swiftly/toolchains/5.10.1/usr/bin/swift "${srcFile}" 2>&1
  `, 30_000);

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
