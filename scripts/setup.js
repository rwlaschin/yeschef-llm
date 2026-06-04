// ============================================================
// Setup - Install all prerequisites automatically
// ============================================================

import { execSync } from "child_process";
import fs from "fs";

function run(cmd, silent = false) {
  try {
    execSync(cmd, { stdio: silent ? "pipe" : "inherit", shell: true });
    return true;
  } catch {
    return false;
  }
}

function check(cmd) {
  try {
    execSync(cmd, { stdio: "pipe", shell: true });
    return true;
  } catch {
    return false;
  }
}

function installPrerequisites() {
  console.log("\n=== Installing Prerequisites ===\n");

  // Node.js
  if (check("node --version")) {
    const v = execSync("node --version", { encoding: "utf8" }).trim();
    console.log(`✓ Node ${v}`);
  }

  // Firebase CLI
  if (!check("firebase --version")) {
    console.log("Installing Firebase CLI...");
    run("npm install -g firebase-tools");
  }
  if (check("firebase --version")) {
    console.log("✓ Firebase CLI installed");
  }

  // Ollama
  if (!check("ollama --version")) {
    console.log("Installing Ollama...");
    run("curl -fsSL https://ollama.com/install.sh | sh");
  }
  if (check("ollama --version")) {
    console.log("✓ Ollama installed");
  } else {
    console.error("\n⚠️  Ollama install script completed, but command not available.");
    console.error("   Ollama may need a restart or manual installation.");
    console.error("   Visit: https://ollama.com\n");
  }

  console.log();
}

function setupEnv() {
  console.log("=== Configuring Environment ===\n");

  const envPath = ".env.dev";
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env.dev not found`);
  }
  console.log(`✓ .env.dev configured`);
  console.log();
}

function main() {
  console.log("\n╔════════════════════════════════════════════════╗");
  console.log("║      Ollama Infrastructure - Setup              ║");
  console.log("╚════════════════════════════════════════════════╝");

  try {
    installPrerequisites();
    setupEnv();

    console.log("═══════════════════════════════════════════════════\n");
    console.log("✓ Setup complete!\n");
    console.log("Next step:");
    console.log("  npm run dev              Start local dev environment\n");
  } catch (err) {
    console.error(`\n❌ Setup failed: ${err.message}\n`);
    process.exit(1);
  }
}

main();
