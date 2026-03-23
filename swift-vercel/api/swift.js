// api/swift.js — Vercel Serverless Function
// Downloads Swift toolchain to /tmp on cold start, then compiles & runs user code.
// Swift 5.10.1 for Linux x86_64 (~170MB compressed, ~380MB extracted)

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

// ── Pure-Node streaming tar extractor ────────────────────────────────
// Vercel's Lambda runtime has no `tar` binary, so we parse the TAR format
// ourselves using only built-in Node modules (https + zlib + fs).
// TAR block = 512 bytes. Header block describes each entry; data follows.

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

async function streamExtractTarGz(urlStr, destDir, stripComponents = 1) {
  mkdirpSync(destDir);
  log(`Streaming download → gunzip → tar extract into ${destDir}`);

  const res = await fetchFollowRedirects(urlStr);

  await new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();

    // TAR state machine
    let buf        = Buffer.alloc(0);
    let header     = null;   // current entry header
    let remaining  = 0;      // bytes left to write for current entry
    let outStream  = null;   // WriteStream for current file
    let bytesIn    = 0;

    function processBuffer() {
      while (true) {
        if (!header) {
          // Need a 512-byte header block
          if (buf.length < 512) return;
          const block = buf.slice(0, 512);
          buf = buf.slice(512);

          // End-of-archive: two consecutive zero blocks
          if (block.every(b => b === 0)) { header = null; continue; }

          header = parseTarHeader(block);
          remaining = header.size;

          // Strip leading path components
          let entryPath = header.name;
          const parts = entryPath.split("/").filter(Boolean);
          if (parts.length <= stripComponents) {
            // Entry IS one of the stripped prefix dirs — skip
            header = null;
            continue;
          }
          const relParts = parts.slice(stripComponents);
          entryPath = path.join(destDir, ...relParts);

          if (header.typeflag === "5" || (header.size === 0 && header.name.endsWith("/"))) {
            // Directory
            mkdirpSync(entryPath);
            header = null;
            continue;
          }

          if (header.typeflag === "2" || header.typeflag === "K") {
            // Symlink — handle after data consumed
            header._dest = entryPath;
            if (header.size === 0) {
              // linkname is already in header
              try {
                mkdirpSync(path.dirname(entryPath));
                if (fs.existsSync(entryPath)) fs.unlinkSync(entryPath);
                fs.symlinkSync(header.linkname, entryPath);
              } catch (_) {}
              header = null;
            }
            // if size > 0, linkname comes in the data (GNU long link); we'll handle below
          } else if (header.typeflag === "L") {
            // GNU long filename — data block contains the real name; handled below
            header._longName = true;
          } else if (header.typeflag === "0" || header.typeflag === "" || header.typeflag === "\0") {
            // Regular file
            try { mkdirpSync(path.dirname(entryPath)); } catch (_) {}
            try {
              outStream = fs.createWriteStream(entryPath, { mode: 0o755 });
              outStream.on("error", reject);
            } catch (e) {
              outStream = null; // skip if can't create
            }
            header._dest = entryPath;
          } else {
            // Ignore other types (hard links, etc.)
          }
        }

        // Write data for current entry
        if (remaining > 0) {
          if (buf.length === 0) return; // wait for more data
          const take = Math.min(remaining, buf.length);
          const chunk = buf.slice(0, take);
          buf = buf.slice(take);
          remaining -= take;

          if (outStream) {
            outStream.write(chunk);
          } else if (header && header._longName) {
            // Accumulate long filename
            header._longNameData = Buffer.concat([header._longNameData || Buffer.alloc(0), chunk]);
          }

          if (remaining === 0) {
            // Drain tar padding to next 512-byte boundary
            const padded = Math.ceil(header.size / 512) * 512;
            const pad    = padded - header.size;
            if (pad > 0) {
              if (buf.length < pad) {
                // Need to wait for pad bytes — store state
                header._awaitPad = pad;
                return;
              }
              buf = buf.slice(pad);
            }
            // Close file
            if (outStream) { outStream.end(); outStream = null; }
            header = null;
          }
        } else if (header && header._awaitPad) {
          // Consume leftover padding
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
      log(`Extracted ${(bytesIn / 1024 / 1024).toFixed(1)} MB uncompressed`);
      resolve();
    });

    gunzip.on("error", reject);
    res.on("error", reject);
    res.pipe(gunzip);
  });
}

async function downloadSwift() {
  log("Swift not found — starting download...");
  log(`URL: ${SWIFT_URL}`);

  // Check available /tmp space (~400 MB needed for extraction only — no tarball saved)
  const freeStr = sh("df -BM /tmp | tail -1 | awk '{print $4}'").stdout.trim().replace("M", "");
  const freeMB  = parseInt(freeStr, 10);
  log(`/tmp available: ${freeMB}MB`);
  if (!isNaN(freeMB) && freeMB < 420) {
    throw new Error(`/tmp has only ${freeMB}MB free — need ~420MB. Clear old work dirs and retry.`);
  }

  await streamExtractTarGz(SWIFT_URL, SWIFT_DIR, 1);

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
