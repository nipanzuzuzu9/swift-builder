// api/status.js — Health check & Swift installation status
const fs = require("fs");

const SWIFT_VERSION = "5.10.1";
const SWIFT_BIN = `/tmp/swift-${SWIFT_VERSION}/usr/bin/swift`;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const cached = fs.existsSync(SWIFT_BIN);

  // Check /tmp free space
  let tmpFreeGB = "unknown";
  try {
    const { execSync } = require("child_process");
    const df = execSync("df -BG /tmp").toString().split("\n")[1];
    const parts = df.trim().split(/\s+/);
    tmpFreeGB = parts[3]; // Available column
  } catch (_) {}

  return res.status(200).json({
    ok: true,
    swift_version: SWIFT_VERSION,
    toolchain_cached: cached,
    tmp_free: tmpFreeGB,
    timestamp: new Date().toISOString(),
  });
};
