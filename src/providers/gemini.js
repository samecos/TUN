/**
 * Google Gemini Ultra 自动化适配器
 * 通过 Playwright 自动化操作 gemini.google.com 网页
 */

class GeminiProvider {
  constructor(browser, providerConfig) {
    this.browser = browser;    // Playwright BrowserContext
    this.config = providerConfig;
    this.pages = new Map();    // conversationId -> page
  }

  /**
   * 发送消息到 Gemini
   */
  async sendMessage(feature, content, conversationId, callbacks) {
    let page = this.pages.get(conversationId);

    if (!page || page.isClosed()) {
      page = await this.createNewChat(feature);
      this.pages.set(conversationId, page);
    }

    try {
      callbacks.onStart();

      // Gemini 的输入框选择器（需根据实际 DOM 调整）
      const inputSelector = 'rich-textarea .ql-editor, .text-input-field textarea, div[contenteditable="true"][aria-label*="input"], .input-area textarea';
      await page.waitForSelector(inputSelector, { timeout: 15000 });

      const inputEl = await page.$(inputSelector);
      if (!inputEl) {
        throw new Error('找不到 Gemini 输入框');
      }

      // 输入内容
      const tagName = await inputEl.evaluate(el => el.tagName.toLowerCase());
      if (tagName === 'textarea' || tagName === 'input') {
        await inputEl.fill(content);
      } else {
        await inputEl.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.type(content, { delay: 10 });
      }

      // 发送
      const sendBtnSelector = 'button[aria-label*="Send"], button[data-test-id="send-button"], .send-button';
      const sendBtn = await page.$(sendBtnSelector);
      if (sendBtn) {
        await sendBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      // 等待回复
      await this.waitForReply(page, conversationId, callbacks);

    } catch (err) {
      callbacks.onError(`Gemini 消息发送失败: ${err.message}`);
    }
  }

  /**
   * 创建新的 Gemini 对话页面
   */
  async createNewChat(feature) {
    const page = await this.browser.newPage();

    let url = 'https://gemini.google.com/app';
    switch (feature) {
      case 'chat':
        url = 'https://gemini.google.com/app';
        break;
      case 'image-gen':
        url = 'https://gemini.google.com/app';
        break;
      case 'code':
        url = 'https://gemini.google.com/app';
        break;
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);  // Gemini 加载较慢

    return page;
  }

  /**
   * 等待 Gemini 回复
   */
  async waitForReply(page, conversationId, callbacks) {
    const maxWait = this.config.sessionTimeout || 300000;
    const startTime = Date.now();
    let lastContent = '';
    let stableCount = 0;
    const STABLE_THRESHOLD = 6;

    await page.waitForTimeout(2000);

    while (Date.now() - startTime < maxWait) {
      try {
        const content = await page.evaluate(() => {
          // Gemini 回复消息选择器（需根据实际 DOM 调整）
          const selectors = [
            'model-response:last-of-type .markdown',
            '.response-content:last-child',
            '.model-response-text:last-child',
            'message-content[class*="model"]:last-of-type',
          ];

          for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
              return els[els.length - 1].textContent || '';
            }
          }
          return '';
        });

        if (content && content !== lastContent) {
          const newPart = content.substring(lastContent.length);
          if (newPart) {
            callbacks.onChunk(newPart);
          }
          lastContent = content;
          stableCount = 0;
        } else if (content && content === lastContent) {
          stableCount++;
          if (stableCount >= STABLE_THRESHOLD) {
            break;
          }
        }
      } catch (e) {
        // ignore
      }

      await page.waitForTimeout(500);
    }

    callbacks.onEnd();
  }

  /**
   * 清理资源
   */
  async cleanup() {
    for (const page of this.pages.values()) {
      try {
        if (!page.isClosed()) await page.close();
      } catch (e) { /* ignore */ }
    }
    this.pages.clear();
  }
}

module.exports = GeminiProvider;
