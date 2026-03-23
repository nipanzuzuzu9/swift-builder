// api/swift.js — Vercel Serverless Function
// Downloads Swift toolchain to /tmp on cold start, then compiles & runs user code.
// Swift 5.10.1 for Linux x86_64: selective extraction keeps disk use ~150MB

const { spawnSync } = require("child_process");
const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const https  = require("https");
const http   = require("http");
const zlib   = require("zlib");

const SWIFT_VERSION = "5.10.1";
const SWIFT_DIR     = `/tmp/swift-${SWIFT_VERSION}`;
const SWIFT_BIN     = `${SWIFT_DIR}/usr/bin/swift`;
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

// Paths to SKIP during extraction — these account for ~220MB of the toolchain
const SKIP_PREFIXES = [
  "usr/bin/swift-package",
  "usr/bin/swift-build",
  "usr/bin/swift-test",
  "usr/bin/swift-run",
  "usr/bin/sourcekit-lsp",
  "usr/bin/swift-symbolgraph-extract",
  "usr/bin/swift-api-digester",
  "usr/bin/lldb",
  "usr/bin/llvm-",
  "usr/lib/swift/pm/",
  "usr/lib/swift_static/",
  "usr/lib/sourcekitd.framework/",
  "usr/lib/libsourcekitdInProc",
  "usr/lib/libIndexStore",
  "usr/share/",
  "usr/lib/swift/clang/lib/",
  "usr/lib/swift/iphoneos",
  "usr/lib/swift/iphonesimulator",
  "usr/lib/swift/macosx",
  "usr/lib/swift/appletv",
  "usr/lib/swift/watch",
  "usr/lib/swift/windows",
  "usr/lib/swift/linux/x86_64",
];

function shouldSkip(relPath) {
  for (const p of SKIP_PREFIXES) {
    if (relPath.startsWith(p)) return true;
  }
  return false;
}

async function streamExtractTarGz(urlStr, destDir, stripComponents = 1) {
  mkdirpSync(destDir);
  log(`Streaming download → selective tar extract into ${destDir}`);

  const res = await fetchFollowRedirects(urlStr);

  await new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();

    let buf        = Buffer.alloc(0);
    let header     = null;
    let remaining  = 0;
    let outStream  = null;
    let bytesIn    = 0;
    let isPaused   = false;

    async function processBuffer() {
      if (isPaused) return;

      while (true) {
        if (!header) {
          if (buf.length < 512) return;
          const block = buf.slice(0, 512);
          buf = buf.slice(512);

          if (block.every(b => b === 0)) { header = null; continue; }

          header = parseTarHeader(block);
          remaining = header.size;

          let entryPath = header.name;
          const parts = entryPath.split("/").filter(Boolean);
          if (parts.length <= stripComponents) {
            header = null;
            continue;
          }
          const relParts = parts.slice(stripComponents);
          const relPath = relParts.join("/");
          entryPath = path.join(destDir, ...relParts);

          if (shouldSkip(relPath)) {
            header._skip = true;
          }

          if (header.typeflag === "5" || (header.size === 0 && header.name.endsWith("/"))) {
            if (!header._skip) mkdirpSync(entryPath);
            header = null;
            continue;
          }

          if (header.typeflag === "2" || header.typeflag === "K") {
            header._dest = entryPath;
            if (header.size === 0) {
              if (!header._skip) {
                try {
                  mkdirpSync(path.dirname(entryPath));
                  if (fs.existsSync(entryPath)) fs.unlinkSync(entryPath);
                  fs.symlinkSync(header.linkname, entryPath);
                } catch (_) {}
              }
              header = null;
            }
          } else if (header.typeflag === "L") {
            header._longName = true;
          } else if (header.typeflag === "0" || header.typeflag === "" || header.typeflag === "\0") {
            if (!header._skip) {
              try { mkdirpSync(path.dirname(entryPath)); } catch (_) {}
              try {
                outStream = fs.createWriteStream(entryPath, { mode: 0o755 });
                outStream.on("error", (err) => {
                  if (err.code === 'ENOSPC') log("ENOSPC during write");
                  reject(err);
                });
              } catch (e) {
                outStream = null;
              }
              header._dest = entryPath;
            }
          }
        }

        if (remaining > 0) {
          if (buf.length === 0) return;
          const take = Math.min(remaining, buf.length);
          const chunk = buf.slice(0, take);
          buf = buf.slice(take);
          remaining -= take;

          if (outStream) {
            const canWrite = outStream.write(chunk);
            if (!canWrite) {
              // Handle backpressure
              isPaused = true;
              gunzip.pause();
              res.pause();
              outStream.once('drain', () => {
                isPaused = false;
                res.resume();
                gunzip.resume();
                processBuffer();
              });
              return; // Stop processing until drain
            }
          } else if (header && header._longName) {
            header._longNameData = Buffer.concat([header._longNameData || Buffer.alloc(0), chunk]);
          }

          if (remaining === 0) {
            const padded = Math.ceil(header.size / 512) * 512;
            const pad    = padded - header.size;
            if (pad > 0) {
              if (buf.length < pad) {
                header._awaitPad = pad;
                return;
              }
              buf = buf.slice(pad);
            }
            if (outStream) { outStream.end(); outStream = null; }
            header = null;
          }
        } else if (header && header._awaitPad) {
          if (buf.length < header._awaitPad) return;
          buf = buf.slice(header._awaitPad);
          delete header._awaitPad;
          if (outStream) { outStream.end(); outStream = null; }
          header = null;
        }
      }
    }

    gunzip.on("data", (chunk) => {
      bytesIn += chunk.length;
      buf = Buffer.concat([buf, chunk]);
      processBuffer();
    });

    gunzip.on("end", () => {
      if (outStream) { outStream.end(); outStream = null; }
      log(`Extracted ${(bytesIn / 1024 / 1024).toFixed(1)} MB`);
      resolve();
    });

    gunzip.on("error", reject);
    res.on("error", reject);
    res.pipe(gunzip);
  });
}

async function downloadSwift() {
  log("Starting download...");
  cleanup(true);

  const freeMB = parseInt(sh("df -BM /tmp | tail -1 | awk '{print $4}'").stdout.trim().replace("M", ""), 10);
  log(`/tmp free: ${freeMB}MB`);
  
  try {
    await streamExtractTarGz(SWIFT_URL, SWIFT_DIR, 1);
  } catch (e) {
    sh(`rm -rf "${SWIFT_DIR}"`);
    throw e;
  }

  const ver = sh(`"${SWIFTC_BIN}" --version 2>&1`, 15_000);
  if (ver.status !== 0) {
    sh(`rm -rf "${SWIFT_DIR}"`);
    throw new Error(`Smoke test failed: ${ver.stdout}`);
  }
}

async function ensureSwift() {
  if (!isSwiftInstalled()) await downloadSwift();
}

function buildEnvStr() {
  return `PATH='${SWIFT_DIR}/usr/bin:/usr/bin:/bin' LD_LIBRARY_PATH='${SWIFT_DIR}/usr/lib/swift/linux:${SWIFT_DIR}/usr/lib' HOME='/tmp' TMPDIR='/tmp'`;
}

async function runSwift(code, action = "run", args = []) {
  await ensureSwift();

  const hash    = crypto.createHash("sha1").update(code + action).digest("hex").slice(0, 10);
  const workDir = `/tmp/sw-${hash}`;
  
  cleanup();

  fs.mkdirSync(workDir, { recursive: true });
  const srcFile = path.join(workDir, "main.swift");
  fs.writeFileSync(srcFile, code, "utf8");

  const E = buildEnvStr();

  if (action === "run") {
    const binPath = path.join(workDir, "main");
    const compile = sh(`env ${E} "${SWIFTC_BIN}" "${srcFile}" -o "${binPath}" 2>&1`, 90_000);
    if (compile.status !== 0) {
      return { success: false, stage: "compile", stderr: compile.stdout, exitCode: compile.status };
    }

    const safeArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const run = sh(`env ${E} "${binPath}" ${safeArgs} 2>&1`, 20_000);
    
    try { sh(`rm -rf "${workDir}"`); } catch (_) {}
    
    return { success: run.status === 0, stage: "run", stdout: run.stdout, exitCode: run.status };

  } else if (action === "interpret") {
    const safeArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const run = sh(`env ${E} "${SWIFT_BIN}" "${srcFile}" ${safeArgs} 2>&1`, 30_000);
    try { sh(`rm -rf "${workDir}"`); } catch (_) {}
    return { success: run.status === 0, stage: "interpret", stdout: run.stdout, exitCode: run.status };
  }

  return { success: false, stderr: `Unknown action: ${action}` };
}

function cleanup(aggressive = false) {
  try {
    const now = Date.now();
    const files = fs.readdirSync("/tmp");
    for (const e of files) {
      if (e.startsWith("sw-") || e.startsWith("main") || e.endsWith(".txt")) {
        const full = path.join("/tmp", e);
        try {
          const stats = fs.statSync(full);
          if (aggressive || (now - stats.mtimeMs > 60_000)) {
            sh(`rm -rf '${full}'`);
          }
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
    log(`FATAL: ${err.message}`);
    // Capture more info for ENOSPC
    let info = "";
    if (err.message.includes("ENOSPC")) {
       try { info = " | " + sh("df -BM /tmp").stdout.trim().split("\n").pop(); } catch(_) {}
    }
    cleanup(true);
    return res.status(500).json({ success: false, error: err.message + info });
  }
};
