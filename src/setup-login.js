/**
 * 登录设置工具
 * 用于首次配置：手动登录 Kimi 和 Gemini，保存登录状态
 *
 * 使用方法: npm run setup
 */

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const readline = require("readline");
const config = require("./config");

const dataDir = config.browserDataDir;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function main() {
  console.log("");
  console.log("  ╔══════════════════════════════════════════╗");
  console.log("  ║     TUN - 登录设置工具                   ║");
  console.log("  ╠══════════════════════════════════════════╣");
  console.log("  ║  此工具将打开浏览器，让你手动登录服务     ║");
  console.log("  ║  登录后的状态会被保存，以后无需重复登录   ║");
  console.log("  ╚══════════════════════════════════════════╝");
  console.log("");

  // 确保数据目录存在
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`[Setup] 已创建浏览器数据目录: ${dataDir}`);
  }

  // 启动可见的浏览器（用户需要手动登录）
  console.log("[Setup] 正在启动浏览器...\n");

  const browser = await chromium.launchPersistentContext(dataDir, {
    headless: false, // 显示浏览器窗口
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  // --- Step 1: 登录 Kimi ---
  if (config.providers.kimi?.enabled) {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  步骤 1: 登录 Kimi (Moonshot)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    const kimiPage = await browser.newPage();
    await kimiPage.goto("https://kimi.com", { waitUntil: "domcontentloaded" });

    console.log("  浏览器已打开 Kimi 登录页面");
    console.log("  请在浏览器中完成登录操作");
    console.log("");

    await ask("  登录完成后，按 Enter 继续...");

    // 验证登录状态
    const kimiLoggedIn = await kimiPage.evaluate(() => {
      // 检查是否有登录成功的标识（需要根据实际页面调整）
      return (
        !document.querySelector('[class*="login"]') ||
        document.querySelector('[class*="avatar"]') !== null
      );
    });

    if (kimiLoggedIn) {
      console.log("  ✅ Kimi 登录状态已保存\n");
    } else {
      console.log("  ⚠️ 无法确认 Kimi 登录状态，请确保已登录\n");
    }
  }

  // --- Step 2: 登录 Gemini ---
  if (config.providers.gemini?.enabled) {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  步骤 2: 登录 Google Gemini");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    const geminiPage = await browser.newPage();
    await geminiPage.goto("https://gemini.google.com", {
      waitUntil: "domcontentloaded",
    });

    console.log("  浏览器已打开 Gemini 登录页面");
    console.log("  请在浏览器中完成 Google 账号登录");
    console.log("");

    await ask("  登录完成后，按 Enter 继续...");

    console.log("  ✅ Gemini 登录状态已保存\n");
  }

  // --- 完成 ---
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  设置完成！");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log("  登录状态已保存到:", dataDir);
  console.log("  现在可以启动服务: npm start");
  console.log("");

  await browser.close();
  rl.close();
}

main().catch((err) => {
  console.error("Setup 出错:", err);
  rl.close();
  process.exit(1);
});
