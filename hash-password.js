const crypto = require("crypto");

const password = process.argv.slice(2).join(" ");
if (!password) {
  console.error("Usage: node hash-password.js \"your strong password\"");
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
console.log(`${salt}:${hash}`);
