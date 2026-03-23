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

function parseTarHeader(block) {
  const str = (off, len) => block.slice(off, off + len).toString("utf8").replace(/\0/g, "").trim();
  const oct = (off, len) => parseInt(str(off, len) || "0", 8);
  const name    = str(0,   100);
  const size    = oct(124,  12);
  const typeflag = str(156,   1);
  const linkname = str(157, 100);
  const prefix  = str(345, 155);
  const fullName = prefix ? `${prefix}/${name}` : name;
  return { name: fullName, size, typeflag, linkname };
}

async function fetchFollowRedirects(urlStr, timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    const maxRedirects = 10;
    let redirects = 0;
    function get(u) {
      const mod = u.startsWith("https") ? https : http;
      const timer = setTimeout(() => reject(new Error(`HTTP timeout after ${timeoutMs}ms`)), timeoutMs);
      mod.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timer);
          if (++redirects > maxRedirects) return reject(new Error("Too many redirects"));
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        clearTimeout(timer);
        resolve(res);
      }).on("error", (e) => { clearTimeout(timer); reject(e); });
    }
    get(urlStr);
  });
}

// v5+: Ultra-aggressive selective extraction. Only keep CRITICAL runtime deps.
function shouldKeep(relPath) {
  // 1. Essential binaries ONLY
  if (relPath === "usr/bin/swiftc") return true;
  if (relPath === "usr/bin/swift-frontend") return true;

  // 2. CRITICAL .so libs only (skip everything else in linux/x86_64/)
  if (relPath.startsWith("usr/lib/swift/linux/x86_64/")) {
    // Keep ONLY essential .so files (and skip most architecture-specific stuff)
    if (relPath.includes("libswiftCore.so") || 
        relPath.includes("libswiftShims.so") ||
        relPath.includes("libswiftGlibc.so") ||
        relPath.includes("libswiftOSLog.so") ||
        relPath.includes("libswiftDispatch.so")) {
      return true;
    }
    // Skip .a (static), .swiftmodule, .swiftdoc, and anything else
    return false;
  }
  
  // 3. ONLY essential .so in root lib/swift/linux/
  if (relPath.startsWith("usr/lib/swift/linux/") && !relPath.includes("x86_64")) {
    if (relPath.endsWith(".so") || relPath.endsWith(".so.1")) return true;
    return false;
  }

  // 4. Minimal shims (only the .so, skip swiftmodule/swiftdoc)
  if (relPath === "usr/lib/swift/shims/module.modulemap") return true;
  if (relPath.startsWith("usr/lib/swift/shims/") && relPath.endsWith(".h")) return true;
  
  // 5. Minimal Glibc (only critical files)
  if (relPath === "usr/lib/swift/linux/Glibc.swiftmodule/x86_64-unknown-linux-gnu.swiftmodule") return true;
  if (relPath === "usr/lib/swift/linux/Glibc.swiftmodule/x86_64-unknown-linux-gnu.swiftdoc") return true;

  // 6. MINIMAL clang headers (only what's absolutely needed for Glibc)
  const clangHeadersCritical = [
    "stddef.h", "stdint.h", "limits.h", "float.h", 
    "stdarg.h", "stdbool.h", "stdnoreturn.h"
  ];
  if (relPath.startsWith("usr/lib/swift/clang/include/")) {
    const fileName = path.basename(relPath);
    if (clangHeadersCritical.includes(fileName)) return true;
    return false;
  }

  return false;
}

async function streamExtractTarGz(urlStr, destDir, stripComponents = 1) {
  mkdirpSync(destDir);
  const res = await fetchFollowRedirects(urlStr);

  await new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    let buf = Buffer.alloc(0);
    let header = null;
    let remaining = 0;
    let currentFd = null;
    let totalWritten = 0;

    function processBuffer() {
      while (true) {
        if (!header) {
          if (buf.length < 512) return;
          const block = buf.slice(0, 512);
          buf = buf.slice(512);
          if (block.every(b => b === 0)) { header = null; continue; }
          header = parseTarHeader(block);
          remaining = header.size;

          const parts = header.name.split("/").filter(Boolean);
          if (parts.length <= stripComponents) { header = null; continue; }
          const relPath = parts.slice(stripComponents).join("/");
          const entryPath = path.join(destDir, relPath);

          if (!shouldKeep(relPath)) {
            header._skip = true;
          }

          if (header.typeflag === "5" || (header.size === 0 && header.name.endsWith("/"))) {
            if (!header._skip) mkdirpSync(entryPath);
            header = null;
            continue;
          }

          if (header.typeflag === "2" || header.typeflag === "K") {
            if (!header._skip) {
              try {
                mkdirpSync(path.dirname(entryPath));
                if (fs.existsSync(entryPath)) fs.unlinkSync(entryPath);
                fs.symlinkSync(header.linkname, entryPath);
              } catch (_) {}
            }
            header = null;
          } else if (header.typeflag === "0" || header.typeflag === "" || header.typeflag === "\0") {
            if (!header._skip) {
              try {
                mkdirpSync(path.dirname(entryPath));
                currentFd = fs.openSync(entryPath, "w", 0o755);
              } catch (e) { currentFd = null; }
            }
          }
        }

        if (remaining > 0) {
          if (buf.length === 0) return;
          const take = Math.min(remaining, buf.length);
          const chunk = buf.slice(0, take);
          buf = buf.slice(take);
          remaining -= take;

          if (currentFd !== null) {
            try { 
              fs.writeSync(currentFd, chunk); 
              totalWritten += chunk.length;
              // Hard limit to prevent ENOSPC before it happens
              if (totalWritten > 80 * 1024 * 1024) {
                 throw new Error("Vercel Write Quota (80MB) reached. Aborting extraction.");
              }
            } catch (e) { throw e; }
          }

          if (remaining === 0) {
            const pad = (Math.ceil(header.size / 512) * 512) - header.size;
            if (pad > 0) {
              if (buf.length < pad) { header._awaitPad = pad; return; }
              buf = buf.slice(pad);
            }
            if (currentFd !== null) { fs.closeSync(currentFd); currentFd = null; }
            header = null;
          }
        } else if (header && header._awaitPad) {
          if (buf.length < header._awaitPad) return;
          buf = buf.slice(header._awaitPad);
          delete header._awaitPad;
          if (currentFd !== null) { fs.closeSync(currentFd); currentFd = null; }
          header = null;
        }
      }
    }

    gunzip.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try { processBuffer(); } catch (e) { reject(e); }
    });
    gunzip.on("end", () => {
      if (currentFd !== null) fs.closeSync(currentFd);
      log(`v5 Selective Extraction: ${Math.round(totalWritten / 1024 / 1024)}MB written.`);
      resolve();
    });
    gunzip.on("error", reject);
    res.on("error", reject);
    res.pipe(gunzip);
  });
}

async function downloadSwift() {
  log("Starting v5 ultra-selective download...");
  cleanup(true);
  try {
    await streamExtractTarGz(SWIFT_URL, SWIFT_DIR, 1);
  } catch (e) {
    sh(`rm -rf "${SWIFT_DIR}"`);
    throw e;
  }
}

async function ensureSwift() {
  if (!isSwiftInstalled()) await downloadSwift();
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
