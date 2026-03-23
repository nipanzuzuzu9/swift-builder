// api/swift.js — Vercel Serverless Function
// Downloads Swift toolchain to /tmp on cold start, then compiles & runs user code.
// Swift 5.10.1 for Linux x86_64 (~170MB compressed, ~380MB extracted)

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SWIFT_VERSION = "5.10.1";
const SWIFT_DIR     = `/tmp/swift-${SWIFT_VERSION}`;
const SWIFT_BIN     = `${SWIFT_DIR}/usr/bin/swift`;
const SWIFTC_BIN    = `${SWIFT_DIR}/usr/bin/swiftc`;
const SWIFT_TAR     = `/tmp/swift.tar.gz`;

const SWIFT_URL =
  `https://download.swift.org/swift-${SWIFT_VERSION}-release/ubuntu2204/x86_64/` +
  `swift-${SWIFT_VERSION}-RELEASE-ubuntu2204.tar.gz`;

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

async function downloadSwift() {
  log("Swift not found — starting download...");
  log(`URL: ${SWIFT_URL}`);
  log(`/tmp available: ${sh("df -BM /tmp | tail -1 | awk '{print $4}'").stdout.trim()}`);

  // Download
  const dl = sh(
    `curl -L --fail --silent --show-error --connect-timeout 30 --retry 3 -o "${SWIFT_TAR}" "${SWIFT_URL}"`,
    180_000
  );
  if (dl.status !== 0) throw new Error(`Download failed (exit ${dl.status}): ${dl.stderr}`);
  log(`Downloaded ${(fs.statSync(SWIFT_TAR).size / 1024 / 1024).toFixed(1)} MB`);

  // Verify archive integrity
  const test = sh(`tar -tzf "${SWIFT_TAR}" 2>&1 | head -3`, 30_000);
  if (test.status !== 0) throw new Error(`Tarball invalid: ${test.stdout}`);
  log(`Archive OK. First entries: ${test.stdout.trim()}`);

  // Extract
  fs.mkdirSync(SWIFT_DIR, { recursive: true });
  log("Extracting (this takes ~60s)...");
  const extract = sh(
    `tar -xf "${SWIFT_TAR}" -C "${SWIFT_DIR}" --strip-components=1 2>&1`,
    180_000
  );
  if (extract.status !== 0) {
    const dfOut = sh("df -h /tmp").stdout;
    throw new Error(
      `Extraction failed (exit ${extract.status}):\n${extract.stdout.slice(0, 1200)}\n/tmp:\n${dfOut}`
    );
  }

  // Remove tarball
  try { fs.unlinkSync(SWIFT_TAR); } catch (_) {}

  // Smoke test
  const ver = sh(`"${SWIFTC_BIN}" --version 2>&1`, 15_000);
  log(`swiftc: ${ver.stdout.trim()}`);
  if (ver.status !== 0) throw new Error(`swiftc smoke test failed: ${ver.stdout}`);
}

async function ensureSwift() {
  if (!isSwiftInstalled()) await downloadSwift();
}

function buildEnvStr() {
  const env = {
    PATH: `${SWIFT_DIR}/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    LD_LIBRARY_PATH: `${SWIFT_DIR}/usr/lib/swift/linux:${SWIFT_DIR}/usr/lib`,
    HOME: "/tmp",
    TMPDIR: "/tmp",
  };
  return Object.entries(env).map(([k, v]) => `${k}='${v}'`).join(" ");
}

async function runSwift(code, action = "run", args = []) {
  await ensureSwift();

  const hash    = crypto.createHash("sha1").update(code + action).digest("hex").slice(0, 10);
  const workDir = `/tmp/sw-${hash}`;
  fs.mkdirSync(workDir, { recursive: true });

  const srcFile = path.join(workDir, "main.swift");
  fs.writeFileSync(srcFile, code, "utf8");

  const E = buildEnvStr();

  if (action === "run") {
    const binPath = path.join(workDir, "main");

    // Compile
    const compile = sh(`env ${E} "${SWIFTC_BIN}" "${srcFile}" -o "${binPath}" 2>&1`, 90_000);
    if (compile.status !== 0) {
      return { success: false, stage: "compile", stdout: "", stderr: compile.stdout, exitCode: compile.status };
    }

    // Run
    const safeArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const stderrFile = `/tmp/sw-err-${hash}.txt`;
    const run = sh(`env ${E} "${binPath}" ${safeArgs} 2>"${stderrFile}"`, 20_000);
    let stderr = "";
    try { stderr = fs.readFileSync(stderrFile, "utf8"); } catch (_) {}
    return { success: run.status === 0, stage: "run", stdout: run.stdout, stderr, exitCode: run.status };

  } else if (action === "interpret") {
    const safeArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const run = sh(`env ${E} "${SWIFT_BIN}" "${srcFile}" ${safeArgs}`, 30_000);
    return { success: run.status === 0, stage: "interpret", stdout: run.stdout, stderr: run.stderr, exitCode: run.status };

  } else if (action === "build-package") {
    let pkg;
    try { pkg = JSON.parse(code); }
    catch { return { success: false, stage: "parse", stderr: 'body.code must be JSON: {"manifest":"...","sources":{"main.swift":"..."}}' }; }

    fs.writeFileSync(path.join(workDir, "Package.swift"), pkg.manifest, "utf8");
    const srcDir = path.join(workDir, "Sources", "Main");
    fs.mkdirSync(srcDir, { recursive: true });
    for (const [fname, content] of Object.entries(pkg.sources || {})) {
      fs.writeFileSync(path.join(srcDir, fname), content, "utf8");
    }
    const build = sh(`cd "${workDir}" && env ${E} "${SWIFT_BIN}" build 2>&1`, 180_000);
    return { success: build.status === 0, stage: "build-package", stdout: build.stdout, stderr: "", exitCode: build.status };
  }

  return { success: false, stderr: `Unknown action: ${action}` };
}

function cleanup() {
  try {
    for (const e of fs.readdirSync("/tmp")) {
      if (!e.startsWith("sw-")) continue;
      const full = path.join("/tmp", e);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > 300_000)
          sh(`rm -rf '${full}'`);
      } catch (_) {}
    }
  } catch (_) {}
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { code, action = "run", args = [] } = req.body || {};
  if (!code || typeof code !== "string")
    return res.status(400).json({ error: "Missing `code` string in body" });
  if (code.length > 50_000)
    return res.status(400).json({ error: "Code too large (max 50KB)" });

  const start = Date.now();
  log(`action=${action} codeLen=${code.length}`);

  try {
    const result = await runSwift(code, action, args);
    cleanup();
    return res.status(200).json({
      ...result,
      elapsed_ms: Date.now() - start,
      swift_version: SWIFT_VERSION,
      cached: isSwiftInstalled(),
    });
  } catch (err) {
    log(`FATAL: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: err.message,
      elapsed_ms: Date.now() - start,
    });
  }
};
