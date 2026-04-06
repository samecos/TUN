/**
 * Google Gemini Ultra 自动化适配器
 * 通过 Playwright 自动化操作 gemini.google.com 网页
 * 
 * 策略：
 * - 输入/发送：Playwright DOM 操作
 * - 接收回复：DOM 轮询获取 innerHTML（Gemini 页面自身渲染 Markdown 为 HTML）
 *   同时尝试网络拦截作为辅助
 * 
 * 注意：Gemini 的回复元素里已经是渲染好的 HTML (h2, table, strong, code 等)
 *       因此我们直接抓取原始 Markdown 文本，让前端统一渲染。
 */

class GeminiProvider {
  constructor(browser, providerConfig) {
    this.browser = browser;
    this.config = providerConfig;
    this.pages = new Map();  // conversationId -> { page, streamCallbacks }
  }

  /**
   * 发送消息到 Gemini
   */
  async sendMessage(feature, content, conversationId, callbacks) {
    let pageInfo = this.pages.get(conversationId);

    if (!pageInfo || pageInfo.page.isClosed()) {
      pageInfo = await this.createNewChat(feature, conversationId);
      this.pages.set(conversationId, pageInfo);
    }

    const { page } = pageInfo;

    try {
      // 输入消息
      await this.typeMessage(page, content);

      // 发送
      await this.sendInput(page);

      console.log(`[Gemini] 消息已发送: "${content.substring(0, 40)}..."`);

      // 等待回复
      await this.waitForReply(page, conversationId, callbacks);

    } catch (err) {
      console.error(`[Gemini] ❌ 错误:`, err.message);
      callbacks.onError(`Gemini 消息发送失败: ${err.message}`);
    }
  }

  /**
   * 输入消息
   */
  async typeMessage(page, content) {
    // Gemini 使用多种输入框选择器
    const inputSelectors = [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
      '.text-input-field textarea',
      'div[contenteditable="true"][aria-label*="input"]',
      'div[contenteditable="true"][aria-label*="Enter"]',
      '.input-area textarea',
      'textarea[aria-label*="prompt"]',
      'div[contenteditable="true"]',
    ];

    let inputEl = null;
    for (const sel of inputSelectors) {
      try {
        inputEl = await page.waitForSelector(sel, { timeout: 3000, state: 'visible' });
        if (inputEl) {
          console.log(`[Gemini] 找到输入框: ${sel}`);
          break;
        }
      } catch (e) { /* next */ }
    }

    if (!inputEl) throw new Error('找不到 Gemini 输入框');

    const tagName = await inputEl.evaluate(el => el.tagName.toLowerCase());

    if (tagName === 'textarea' || tagName === 'input') {
      await inputEl.fill('');
      await inputEl.fill(content);
    } else {
      await inputEl.click();
      await page.waitForTimeout(200);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(100);

      if (content.length <= 200) {
        await page.keyboard.type(content, { delay: 8 });
      } else {
        // 长文本注入
        await inputEl.evaluate((el, text) => {
          el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, content);
        await page.waitForTimeout(200);
      }
    }
  }

  /**
   * 发送消息（点击发送按钮或按 Enter）
   */
  async sendInput(page) {
    const sendSelectors = [
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[data-test-id="send-button"]',
      'button.send-button',
      '.send-button',
    ];

    for (const sel of sendSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const isDisabled = await btn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
          if (!isDisabled) {
            await btn.click();
            console.log(`[Gemini] 点击发送按钮: ${sel}`);
            return;
          }
        }
      } catch (e) { /* next */ }
    }

    // Fallback: Enter 键
    console.log(`[Gemini] 使用 Enter 发送`);
    await page.keyboard.press('Enter');
  }

  /**
   * 等待 Gemini 回复
   *
   * 策略：DOM 轮询获取回复内容
   * Gemini 页面已将 Markdown 渲染为 HTML，我们在浏览器内
   * 执行 HTML→Markdown 反转换，保留格式后发给前端统一渲染。
   */
  async waitForReply(page, conversationId, callbacks) {
    const maxWait = this.config.sessionTimeout || 300000;
    const startTime = Date.now();
    let lastContent = '';
    let stableCount = 0;
    const STABLE_THRESHOLD = 8;  // 8 * 500ms = 4 秒稳定
    let started = false;

    // 等待响应开始出现
    await page.waitForTimeout(2000);

    while (Date.now() - startTime < maxWait) {
      try {
        // 在 Gemini 页面中执行，把渲染后的 HTML 反转为 Markdown
        const result = await page.evaluate(() => {
          // ---------- HTML → Markdown 轻量转换器 ----------
          function htmlToMarkdown(el) {
            if (!el) return '';
            let md = '';
            for (const child of el.childNodes) {
              if (child.nodeType === Node.TEXT_NODE) {
                md += child.textContent;
                continue;
              }
              if (child.nodeType !== Node.ELEMENT_NODE) continue;

              const tag = child.tagName.toLowerCase();

              // 标题
              if (/^h[1-6]$/.test(tag)) {
                const level = parseInt(tag[1]);
                md += '\n' + '#'.repeat(level) + ' ' + child.textContent.trim() + '\n\n';
                continue;
              }

              // 段落
              if (tag === 'p') {
                md += htmlToMarkdown(child) + '\n\n';
                continue;
              }

              // 加粗
              if (tag === 'strong' || tag === 'b') {
                md += '**' + child.textContent + '**';
                continue;
              }

              // 斜体
              if (tag === 'em' || tag === 'i') {
                md += '*' + child.textContent + '*';
                continue;
              }

              // 行内代码
              if (tag === 'code' && child.parentElement?.tagName?.toLowerCase() !== 'pre') {
                md += '`' + child.textContent + '`';
                continue;
              }

              // 代码块
              if (tag === 'pre') {
                const codeEl = child.querySelector('code');
                const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] || '';
                const code = (codeEl || child).textContent;
                md += '\n```' + lang + '\n' + code + '\n```\n\n';
                continue;
              }

              // 无序列表
              if (tag === 'ul') {
                for (const li of child.querySelectorAll(':scope > li')) {
                  md += '- ' + htmlToMarkdown(li).trim() + '\n';
                }
                md += '\n';
                continue;
              }

              // 有序列表
              if (tag === 'ol') {
                let idx = 1;
                for (const li of child.querySelectorAll(':scope > li')) {
                  md += idx + '. ' + htmlToMarkdown(li).trim() + '\n';
                  idx++;
                }
                md += '\n';
                continue;
              }

              // 表格
              if (tag === 'table') {
                const rows = child.querySelectorAll('tr');
                const tableData = [];
                for (const row of rows) {
                  const cells = row.querySelectorAll('th, td');
                  tableData.push(Array.from(cells).map(c => c.textContent.trim()));
                }
                if (tableData.length > 0) {
                  const colCount = Math.max(...tableData.map(r => r.length));
                  // 表头
                  md += '| ' + tableData[0].join(' | ') + ' |\n';
                  md += '| ' + Array(colCount).fill('---').join(' | ') + ' |\n';
                  // 数据行
                  for (let r = 1; r < tableData.length; r++) {
                    md += '| ' + tableData[r].join(' | ') + ' |\n';
                  }
                  md += '\n';
                }
                continue;
              }

              // 引用
              if (tag === 'blockquote') {
                const lines = child.textContent.trim().split('\n');
                md += lines.map(l => '> ' + l).join('\n') + '\n\n';
                continue;
              }

              // 分割线
              if (tag === 'hr') {
                md += '\n---\n\n';
                continue;
              }

              // 链接
              if (tag === 'a') {
                const href = child.getAttribute('href') || '';
                md += '[' + child.textContent + '](' + href + ')';
                continue;
              }

              // br
              if (tag === 'br') {
                md += '\n';
                continue;
              }

              // div / span / 其他：递归处理
              md += htmlToMarkdown(child);
            }
            return md;
          }
          // ---------- END 转换器 ----------

          // Gemini 回复容器选择器
          const containerSelectors = [
            'model-response:last-of-type .markdown-main-panel',
            'model-response:last-of-type .markdown',
            'model-response:last-of-type message-content',
            '.response-container:last-child .markdown',
            '.model-response-text:last-child',
            'message-content[class*="model"]:last-of-type',
          ];

          for (const sel of containerSelectors) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
              const lastEl = els[els.length - 1];
              const markdown = htmlToMarkdown(lastEl).trim();
              if (markdown) {
                return { text: markdown, found: true, selector: sel };
              }
            }
          }

          // 备用：model-response
          const allResponses = document.querySelectorAll('model-response');
          if (allResponses.length > 0) {
            const last = allResponses[allResponses.length - 1];
            return {
              text: htmlToMarkdown(last).trim(),
              found: true,
              selector: 'model-response (fallback)',
            };
          }

          return { text: '', found: false, selector: '' };
        });

        if (result.found && result.text && result.text !== lastContent) {
          if (!started) {
            started = true;
            callbacks.onStart();
            console.log(`[Gemini] 响应开始 (via ${result.selector})`);
          }

          // 发送增量内容
          const newPart = lastContent ? result.text.substring(lastContent.length) : result.text;
          if (newPart) {
            callbacks.onChunk(newPart);
          }
          lastContent = result.text;
          stableCount = 0;
        } else if (result.found && result.text && result.text === lastContent && result.text.length > 0) {
          stableCount++;
          if (stableCount >= STABLE_THRESHOLD) {
            console.log(`[Gemini] 响应稳定，判定为完成 (${lastContent.length} 字符)`);
            break;
          }
        }

        // 检查是否有停止生成的按钮消失（表示生成完成）
        const isGenerating = await page.evaluate(() => {
          const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="stop"], .stop-button');
          return !!stopBtn;
        }).catch(() => false);

        if (!isGenerating && started && stableCount >= 3) {
          console.log(`[Gemini] 停止按钮已消失，响应完成`);
          break;
        }

      } catch (e) {
        console.error(`[Gemini] 轮询错误:`, e.message);
      }

      await page.waitForTimeout(500);
    }

    if (!started) {
      // 尝试最后一次获取
      try {
        const lastTry = await page.evaluate(() => {
          const el = document.querySelector('model-response:last-of-type');
          return el ? (el.innerText || el.textContent || '').trim() : '';
        });
        if (lastTry) {
          callbacks.onStart();
          callbacks.onChunk(lastTry);
          started = true;
        }
      } catch (e) { /* ignore */ }
    }

    if (!started) {
      callbacks.onStart();
      callbacks.onChunk('⚠️ 未能获取到 Gemini 的回复，请重试。');
    }

    callbacks.onEnd();
    console.log(`[Gemini] ✅ 响应接收完毕`);
  }

  /**
   * 创建新的 Gemini 对话页面
   */
  async createNewChat(feature, conversationId) {
    const page = await this.browser.newPage();
    const pageInfo = { page, streamCallbacks: null };

    const url = 'https://gemini.google.com/app';
    console.log(`[Gemini] 打开新对话: ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const finalUrl = page.url();
    console.log(`[Gemini] 页面就绪: ${finalUrl} (${await page.title()})`);

    // 检查是否需要登录
    if (finalUrl.includes('accounts.google.com') || finalUrl.includes('signin')) {
      console.error(`[Gemini] ⚠️ 需要登录! 当前 URL: ${finalUrl}`);
      console.error(`[Gemini] 请运行 npm run setup 重新登录 Google 账号`);
    }

    // 记录页面信息用于调试
    const pageDebug = await page.evaluate(() => {
      return {
        url: window.location.href,
        inputs: document.querySelectorAll('[contenteditable="true"], textarea').length,
        modelResponses: document.querySelectorAll('model-response').length,
        hasRichTextarea: !!document.querySelector('rich-textarea'),
      };
    });
    console.log(`[Gemini] 页面信息:`, JSON.stringify(pageDebug));

    return pageInfo;
  }

  /**
   * 清理资源
   */
  async cleanup() {
    for (const { page } of this.pages.values()) {
      try {
        if (!page.isClosed()) await page.close();
      } catch (e) { /* ignore */ }
    }
    this.pages.clear();
  }
}

module.exports = GeminiProvider;
