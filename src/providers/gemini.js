/**
 * Google Gemini Ultra 自动化适配器
 * 通过 Playwright 自动化操作 gemini.google.com 网页
 *
 * 策略：
 * - 输入/发送：Playwright DOM 操作
 * - 接收回复：DOM 轮询，使用 baselineCount 精确追踪新增的 model-response
 * - 格式保留：HTML → Markdown 反转换，保留标题/表格/代码块/列表等格式
 */

class GeminiProvider {
    constructor(browser, providerConfig) {
        this.browser = browser;
        this.config = providerConfig;
        this.pages = new Map(); // conversationId -> { page }
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
            // 记录发送前 model-response 数量（基准线）
            const baselineCount = await page.evaluate(() => {
                return document.querySelectorAll('model-response').length;
            });
            console.log(`[Gemini] 基准 model-response 数量: ${baselineCount}`);

            // 输入消息
            await this.typeMessage(page, content);

            // 发送
            await this.sendInput(page);
            console.log(`[Gemini] 消息已发送: "${content.substring(0, 40)}..."`);

            // 等待回复
            await this.waitForReply(page, conversationId, callbacks, baselineCount);
        } catch (err) {
            console.error(`[Gemini] ❌ 错误:`, err.message);
            callbacks.onError(`Gemini 消息发送失败: ${err.message}`);
        }
    }

    /**
     * 输入消息
     */
    async typeMessage(page, content) {
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
                await inputEl.evaluate((el, text) => {
                    el.textContent = text;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }, content);
                await page.waitForTimeout(200);
            }
        }
    }

    /**
     * 发送消息
     */
    async sendInput(page) {
        const sendSelectors = [
            'button[aria-label*="Send"]',
            'button[aria-label*="send"]',
            'button[aria-label*="发送"]',
            'button[data-test-id="send-button"]',
            'button.send-button',
            '.send-button',
        ];

        for (const sel of sendSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn) {
                    const isDisabled = await btn.evaluate(
                        el => el.disabled || el.getAttribute('aria-disabled') === 'true'
                    );
                    if (!isDisabled) {
                        await btn.click();
                        console.log(`[Gemini] 点击发送按钮: ${sel}`);
                        return;
                    }
                }
            } catch (e) { /* next */ }
        }

        console.log(`[Gemini] 使用 Enter 发送`);
        await page.keyboard.press('Enter');
    }

    /**
     * 注入 HTML→Markdown 转换器到页面
     * 只需注入一次，后续轮询调用 window.__tunExtractResponse(baseline) 即可
     */
    async injectExtractor(page) {
        await page.evaluate(() => {
            // 如果已经注入过，跳过
            if (window.__tunHtmlToMd) return;

            window.__tunHtmlToMd = function(el) {
                if (!el) return '';
                let md = '';
                for (const child of el.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        md += child.textContent;
                        continue;
                    }
                    if (child.nodeType !== Node.ELEMENT_NODE) continue;
                    const tag = child.tagName.toLowerCase();

                    if (/^h[1-6]$/.test(tag)) {
                        const level = parseInt(tag[1]);
                        md += '\n' + '#'.repeat(level) + ' ' + child.textContent.trim() + '\n\n';
                        continue;
                    }
                    if (tag === 'p') { md += window.__tunHtmlToMd(child) + '\n\n'; continue; }
                    if (tag === 'strong' || tag === 'b') { md += '**' + child.textContent + '**'; continue; }
                    if (tag === 'em' || tag === 'i') { md += '*' + child.textContent + '*'; continue; }
                    if (tag === 'code' && child.parentElement?.tagName?.toLowerCase() !== 'pre') {
                        md += '`' + child.textContent + '`';
                        continue;
                    }
                    if (tag === 'pre') {
                        const codeEl = child.querySelector('code');
                        const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] || '';
                        const code = (codeEl || child).textContent;
                        md += '\n```' + lang + '\n' + code + '\n```\n\n';
                        continue;
                    }
                    if (tag === 'ul') {
                        for (const li of child.querySelectorAll(':scope > li')) {
                            md += '- ' + window.__tunHtmlToMd(li).trim() + '\n';
                        }
                        md += '\n';
                        continue;
                    }
                    if (tag === 'ol') {
                        let idx = 1;
                        for (const li of child.querySelectorAll(':scope > li')) {
                            md += idx + '. ' + window.__tunHtmlToMd(li).trim() + '\n';
                            idx++;
                        }
                        md += '\n';
                        continue;
                    }
                    if (tag === 'table') {
                        const rows = child.querySelectorAll('tr');
                        const tableData = [];
                        for (const row of rows) {
                            const cells = row.querySelectorAll('th, td');
                            tableData.push(Array.from(cells).map(c => c.textContent.trim()));
                        }
                        if (tableData.length > 0) {
                            const colCount = Math.max(...tableData.map(r => r.length));
                            md += '| ' + tableData[0].join(' | ') + ' |\n';
                            md += '| ' + Array(colCount).fill('---').join(' | ') + ' |\n';
                            for (let r = 1; r < tableData.length; r++) {
                                md += '| ' + tableData[r].join(' | ') + ' |\n';
                            }
                            md += '\n';
                        }
                        continue;
                    }
                    if (tag === 'blockquote') {
                        const lines = child.textContent.trim().split('\n');
                        md += lines.map(l => '> ' + l).join('\n') + '\n\n';
                        continue;
                    }
                    if (tag === 'hr') { md += '\n---\n\n'; continue; }
                    if (tag === 'a') {
                        const href = child.getAttribute('href') || '';
                        md += '[' + child.textContent + '](' + href + ')';
                        continue;
                    }
                    if (tag === 'br') { md += '\n'; continue; }
                    md += window.__tunHtmlToMd(child);
                }
                return md;
            };

            window.__tunExtractResponse = function(baseline) {
                const allResponses = document.querySelectorAll('model-response');
                const currentCount = allResponses.length;

                if (currentCount <= baseline) {
                    return { text: '', found: false, selector: 'no-new-response', count: currentCount, baseline: baseline };
                }

                const target = allResponses[currentCount - 1];

                // 精确内容选择器（排除"Gemini 说"标题和操作按钮）
                const selectors = [
                    '.markdown-main-panel',
                    '.markdown',
                    '.model-response-text .markdown-main-panel',
                    '.model-response-text .markdown',
                    '.model-response-text',
                    'message-content',
                    'structured-content-container',
                ];

                for (const sel of selectors) {
                    const mdEl = target.querySelector(sel);
                    if (mdEl) {
                        const markdown = window.__tunHtmlToMd(mdEl).trim();
                        if (markdown) {
                            return {
                                text: markdown,
                                found: true,
                                selector: sel,
                                count: currentCount,
                                baseline: baseline,
                            };
                        }
                    }
                }

                // 没找到内容，返回调试信息
                return {
                    text: '',
                    found: false,
                    selector: 'content-not-ready',
                    count: currentCount,
                    baseline: baseline,
                    targetHTML: target.innerHTML.substring(0, 200),
                    targetChildren: Array.from(target.children).map(c => c.tagName + '.' + (c.className || '').substring(0, 40)),
                };
            };
        });
        console.log(`[Gemini] ✅ 提取器已注入`);
    }

    /**
     * 等待 Gemini 回复
     */
    async waitForReply(page, conversationId, callbacks, baselineCount) {
        const maxWait = this.config.sessionTimeout || 300000;
        const startTime = Date.now();
        let lastContent = '';
        let stableCount = 0;
        const STABLE_THRESHOLD = 8;
        let started = false;
        let pollCount = 0;

        // 注入提取器
        await this.injectExtractor(page);

        // 等待页面开始响应
        await page.waitForTimeout(2000);

        while (Date.now() - startTime < maxWait) {
            pollCount++;
            try {
                const result = await page.evaluate(
                    (b) => window.__tunExtractResponse(b),
                    baselineCount
                );

                // 每 10 次轮询打印一次状态
                if (pollCount % 10 === 1 || result.found) {
                    console.log(`[Gemini] 轮询#${pollCount}: found=${result.found}, count=${result.count}, baseline=${result.baseline}, selector=${result.selector}, textLen=${(result.text || '').length}`);
                    if (!result.found && result.targetChildren) {
                        console.log(`[Gemini]   子元素: ${JSON.stringify(result.targetChildren)}`);
                    }
                }

                if (result.found && result.text && result.text !== lastContent) {
                    if (!started) {
                        started = true;
                        callbacks.onStart();
                        console.log(`[Gemini] 响应开始 (via ${result.selector})`);
                    }

                    const newPart = lastContent
                        ? result.text.substring(lastContent.length)
                        : result.text;
                    if (newPart) {
                        callbacks.onChunk(newPart);
                    }
                    lastContent = result.text;
                    stableCount = 0;
                } else if (
                    result.found && result.text &&
                    result.text === lastContent && result.text.length > 0
                ) {
                    stableCount++;
                    if (stableCount >= STABLE_THRESHOLD) {
                        console.log(`[Gemini] 响应稳定 (${lastContent.length} 字符, ${stableCount} 次稳定)`);
                        break;
                    }
                }

                // 检查停止按钮
                if (started) {
                    const isGenerating = await page.evaluate(() => {
                        const stopBtn = document.querySelector(
                            'button[aria-label*="Stop"], button[aria-label*="stop"], button[aria-label*="停止"]'
                        );
                        return !!stopBtn;
                    }).catch(() => false);

                    if (!isGenerating && stableCount >= 3) {
                        console.log(`[Gemini] 停止按钮已消失，响应完成`);
                        break;
                    }
                }
            } catch (e) {
                console.error(`[Gemini] 轮询#${pollCount} 错误:`, e.message);
            }

            await page.waitForTimeout(500);
        }

        console.log(`[Gemini] 轮询结束: started=${started}, 总轮询=${pollCount}, 耗时=${Date.now() - startTime}ms`);

        if (!started) {
            // 超时后最后一次尝试 - 直接用 innerText
            try {
                const lastTry = await page.evaluate((baseline) => {
                    const all = document.querySelectorAll('model-response');
                    if (all.length > baseline) {
                        const last = all[all.length - 1];
                        // 尝试精确提取
                        const precise = last.querySelector('.model-response-text') || last.querySelector('.markdown');
                        if (precise) {
                            return (precise.innerText || precise.textContent || '').trim();
                        }
                        return (last.innerText || last.textContent || '').trim();
                    }
                    return '';
                }, baselineCount);

                if (lastTry) {
                    callbacks.onStart();
                    callbacks.onChunk(lastTry);
                    started = true;
                    console.log(`[Gemini] 最终尝试成功: ${lastTry.length} 字符`);
                }
            } catch (e) {
                console.error(`[Gemini] 最终尝试失败:`, e.message);
            }
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
        const pageInfo = { page };

        const url = 'https://gemini.google.com/app';
        console.log(`[Gemini] 打开新对话: ${url}`);

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);

        const finalUrl = page.url();
        const title = await page.title();
        console.log(`[Gemini] 页面就绪: ${finalUrl} (${title})`);

        // 登录状态诊断
        if (finalUrl.includes('accounts.google.com') || finalUrl.includes('signin')) {
            console.error(`[Gemini] ❌ 未登录! 被重定向到: ${finalUrl}`);
            console.error(`[Gemini] 请运行 npm run setup 重新登录 Google 账号`);
        }

        const loginState = await page.evaluate(() => {
            const info = {};
            info.hasSID = document.cookie.includes('SID');
            info.hasHSID = document.cookie.includes('HSID');
            info.hasRichTextarea = !!document.querySelector('rich-textarea');
            info.modelResponseCount = document.querySelectorAll('model-response').length;
            info.url = window.location.href;

            const accountBtn = document.querySelector(
                'a[aria-label*="Google Account"], button[aria-label*="Google Account"], img[src*="googleusercontent"]'
            );
            info.hasAccountElement = !!accountBtn;
            if (accountBtn) info.accountLabel = accountBtn.getAttribute('aria-label') || '';

            const signInBtns = document.querySelectorAll('a[href*="signin"], button[data-action*="sign"]');
            info.hasSignInButton = signInBtns.length > 0;

            return info;
        });

        console.log(`[Gemini] 登录状态:`, JSON.stringify(loginState));

        if (loginState.hasAccountElement) {
            console.log(`[Gemini] ✅ 已登录 (${loginState.accountLabel || '检测到账号元素'})`);
        } else if (loginState.hasSignInButton) {
            console.error(`[Gemini] ⚠️ 页面存在 Sign in 按钮，可能未登录`);
        }

        // 尝试自动切换到“快速回答”模型
        try {
            await page.evaluate(async () => {
                // 打开模型选择器
                const switchBtn = document.querySelector('button[aria-label="打开模式选择器"], .input-area-switch button') ||
                    Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Gemini') || b.textContent.includes('快速') || b.textContent.includes('Pro') || b.textContent.includes('Advanced'));

                if (switchBtn) {
                    switchBtn.click();
                    // 等待菜单出现
                    await new Promise(r => setTimeout(r, 500));
                    // 尝试点击对应的模型 (优先找带有模式id的元素，或者data-test-id，或仅仅是文本)
                    const fastBtn = document.querySelector('button[data-mode-id="fbb127bbb056c959"], button[data-test-id*="快速"], button[data-test-id*="fast"]') ||
                        Array.from(document.querySelectorAll('[role="menuitem"]')).find(b => b.textContent.includes('快速') || b.textContent.includes('Fast'));

                    if (fastBtn) {
                        fastBtn.click();
                        console.log('✅ 已选择快速模型');
                    } else {
                        // 如果连快速选项也找不到，就点击空白处关掉选择器
                        document.body.click();
                    }
                    await new Promise(r => setTimeout(r, 300));
                }
            });
            console.log(`[Gemini] ✅ 已尝试绑定为快速回答模型`);
        } catch (e) {
            console.log(`[Gemini] ⚠️ 切换快速模型时出错: ${e.message}`);
        }

        // 预注入提取器
        await this.injectExtractor(page);

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
