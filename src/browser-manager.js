/**
 * 浏览器管理器
 * 管理 Playwright 浏览器实例和登录状态
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const config = require('./config');

class BrowserManager {
  constructor() {
    this.browser = null;
    this.providers = {};  // provider key -> provider instance
    this.ready = false;
  }

  /**
   * 初始化浏览器管理器
   * 检查是否有保存的登录状态，如果有则启动浏览器
   */
  async initialize() {
    const dataDir = config.browserDataDir;

    // 检查 browser-data 目录是否存在
    if (!fs.existsSync(dataDir)) {
      console.log('[Browser] 未找到浏览器数据目录，请先运行 npm run setup');
      return false;
    }

    try {
      // 使用持久化上下文启动浏览器（保留登录状态）
      this.browser = await chromium.launchPersistentContext(dataDir, {
        headless: true,         // 无界面运行
        viewport: { width: 1280, height: 800 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
        ],
      });

      // 加载各个 provider
      await this.loadProviders();

      this.ready = true;
      return true;
    } catch (err) {
      console.error('[Browser] 启动失败:', err.message);
      return false;
    }
  }

  isReady() {
    return this.ready && this.browser !== null;
  }

  /**
   * 加载 provider 适配器
   */
  async loadProviders() {
    for (const [key, cfg] of Object.entries(config.providers)) {
      if (!cfg.enabled) continue;

      try {
        const ProviderClass = require(`./providers/${key}`);
        this.providers[key] = new ProviderClass(this.browser, cfg);
        console.log(`[Browser] Provider "${key}" 已加载`);
      } catch (err) {
        console.warn(`[Browser] Provider "${key}" 加载失败:`, err.message);
      }
    }
  }

  /**
   * 发送消息到指定 provider
   */
  async sendMessage(providerKey, feature, content, conversationId, callbacks) {
    const provider = this.providers[providerKey];
    if (!provider) {
      throw new Error(`Provider "${providerKey}" 不可用`);
    }

    await provider.sendMessage(feature, content, conversationId, callbacks);
  }

  /**
   * 清理资源
   */
  async cleanup() {
    for (const provider of Object.values(this.providers)) {
      try {
        await provider.cleanup();
      } catch (e) {
        // ignore
      }
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {
        // ignore
      }
    }

    this.ready = false;
    console.log('[Browser] 已清理');
  }
}

module.exports = BrowserManager;
