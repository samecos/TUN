/**
 * Kimi (Moonshot) 自动化适配器
 *
 * 策略：
 * - 输入/发送：Playwright DOM 操作 (.chat-input-editor + Enter)
 * - 接收回复：在浏览器中注入 fetch 拦截器，实时读取 ChatService/Chat 的
 *   ReadableStream 流式响应，通过 exposeFunction 桥接回 Node.js
 *
 * Kimi 的流式数据协议：
 * - 每条消息是一个 JSON 对象，前面有一个长度前缀字节
 * - op:"set"   mask:"block.text"         → 设置初始文本块
 * - op:"append" mask:"block.text.content" → 追加文本内容
 * - heartbeat:{} → 心跳（忽略）
 * - block.tool   → 工具调用（如 web_search），可通知用户
 * - message.status:"MESSAGE_STATUS_COMPLETED" → 回复结束
 */

const { queue } = require('../config');

class KimiProvider {
    constructor(browser, providerConfig) {
        this.browser = browser;
        this.config = providerConfig;
        this.pages = new Map(); // conversationId -> { page, callbacks }
    }

    /**
     * 发送消息到 Kimi
     */
    async sendMessage(feature, content, conversationId, callbacks) {
        let pageInfo = this.pages.get(conversationId);

        if (!pageInfo || pageInfo.page.isClosed()) {
            pageInfo = await this.createNewChat(feature, conversationId);
            this.pages.set(conversationId, pageInfo);
        }

        const { page } = pageInfo;

        try {
            // 处理遮罩
            await this.dismissOverlays(page);

            // 设置回调 — 当浏览器内的拦截器捕获到数据时会调用
            const responsePromise = this.setupStreamCallbacks(pageInfo, callbacks);

            // 输入消息
            await this.typeMessage(page, content);

            // 按 Enter 发送
            await page.keyboard.press('Enter');
            console.log(`[Kimi] 消息已发送，等待流式响应...`);

            // 等待响应流完成
            await responsePromise;
            console.log(`[Kimi] ✅ 响应接收完毕`);
        } catch (err) {
            console.error(`[Kimi] ❌ 错误:`, err.message);
            callbacks.onError(`Kimi 消息发送失败: ${err.message}`);
        }
    }

    /**
     * 设置流式响应回调
     */
    setupStreamCallbacks(pageInfo, callbacks) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pageInfo.streamCallbacks = null;
                reject(new Error('等待 Kimi 响应超时 (5 分钟)'));
            }, queue.requestTimeout);

            let started = false;
            let fullText = '';
            let searchNotified = false;

            pageInfo.streamCallbacks = {
                onRawChunk: (rawData) => {
                    // 解析原始数据中的 JSON 消息
                    const messages = this.extractJSON(rawData);

                    for (const msg of messages) {
                        try {
                            const data = JSON.parse(msg);

                            // 心跳 — 忽略
                            if (data.heartbeat) continue;

                            // 工具调用状态（如搜索中）
                            if (
                                data.op === 'set' &&
                                data.block?.tool?.status === 'STATUS_RUNNING'
                            ) {
                                if (!searchNotified) {
                                    searchNotified = true;
                                    if (!started) {
                                        started = true;
                                        callbacks.onStart();
                                    }
                                    callbacks.onChunk('🔍 正在搜索相关信息...\n\n');
                                }
                                continue;
                            }

                            // 文本块初始化
                            if (
                                data.op === 'set' &&
                                data.mask === 'block.text' &&
                                data.block?.text?.content
                            ) {
                                if (!started) {
                                    started = true;
                                    callbacks.onStart();
                                }
                                const text = data.block.text.content;
                                fullText += text;
                                callbacks.onChunk(text);
                                continue;
                            }

                            // 文本追加（核心！）
                            if (
                                data.op === 'append' &&
                                data.mask === 'block.text.content' &&
                                data.block?.text?.content
                            ) {
                                if (!started) {
                                    started = true;
                                    callbacks.onStart();
                                }
                                const text = data.block.text.content;
                                fullText += text;
                                callbacks.onChunk(text);
                                continue;
                            }

                            // 消息完成
                            if (
                                data.op === 'set' &&
                                data.message?.status === 'MESSAGE_STATUS_COMPLETED' &&
                                data.message?.role === 'assistant'
                            ) {
                                // 流结束
                                clearTimeout(timeout);
                                pageInfo.streamCallbacks = null;
                                if (!started) {
                                    started = true;
                                    callbacks.onStart();
                                }
                                callbacks.onEnd();
                                resolve(fullText);
                                return;
                            }
                        } catch (e) {
                            // 解析失败的 JSON 片段，忽略
                        }
                    }
                },

                onStreamEnd: () => {
                    clearTimeout(timeout);
                    pageInfo.streamCallbacks = null;
                    if (!started) {
                        started = true;
                        callbacks.onStart();
                    }
                    callbacks.onEnd();
                    resolve(fullText);
                },

                onStreamError: (errMsg) => {
                    console.error(`[Kimi] 流错误: ${errMsg}`);
                    // 不立即 reject，可能只是一个子请求错误
                },
            };
        });
    }

    /**
     * 从原始数据中提取 JSON 对象
     * Kimi 的协议是长度前缀字节 + JSON，我们用花括号匹配来提取
     *
     * 关键：必须感知 JSON 字符串字面量（"..." 内部的 { } 要忽略），
     * 否则 Markdown 代码块等内容中的花括号会打乱计数，导致后续
     * 所有消息都无法解析，表现为界面卡住。
     */
    extractJSON(text) {
        const results = [];
        let i = 0;

        while (i < text.length) {
            // 寻找 JSON 对象的起始 {
            if (text[i] !== '{') {
                i++;
                continue;
            }

            let depth = 0;
            let inString = false;
            let escaped = false;
            const start = i;

            for (let j = i; j < text.length; j++) {
                const ch = text[j];

                if (escaped) {
                    // 前一个字符是 \，当前字符被转义，跳过
                    escaped = false;
                    continue;
                }

                if (inString) {
                    // 在字符串内部：只关心 \ 和 "
                    if (ch === '\\') {
                        escaped = true;
                    } else if (ch === '"') {
                        inString = false;
                    }
                    continue;
                }

                // 在字符串外部
                if (ch === '"') {
                    inString = true;
                } else if (ch === '{') {
                    depth++;
                } else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        results.push(text.substring(start, j + 1));
                        i = j + 1;
                        break;
                    }
                }

                // 到达末尾仍未闭合 — 跳过此 { 防止死循环
                if (j === text.length - 1 && depth !== 0) {
                    i = start + 1;
                }
            }

            // 安全保障：如果内层循环没有推进 i，手动推进防止死循环
            if (i === start) {
                i++;
            }
        }

        return results;
    }

    /**
     * 关闭遮罩层
     */
    async dismissOverlays(page) {
        try {
            await page.evaluate(() => {
                document.querySelectorAll('.mask').forEach((el) => {
                    el.style.display = 'none';
                    el.style.pointerEvents = 'none';
                });
            });
        } catch (e) {
            /* ignore */
        }
    }

    /**
     * 输入消息
     */
    async typeMessage(page, content) {
        const selectors = [
            '.chat-input-editor[contenteditable="true"]',
            'div[contenteditable="true"][class*="editor"]',
            'div[contenteditable="true"]',
        ];

        let inputEl = null;
        for (const sel of selectors) {
            try {
                inputEl = await page.waitForSelector(sel, {
                    timeout: 5000,
                    state: 'visible',
                });
                if (inputEl) break;
            } catch (e) {
                /* next */
            }
        }

        if (!inputEl) throw new Error('找不到 Kimi 输入框');

        await inputEl.click({ force: true });
        await page.waitForTimeout(300);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(100);

        if (content.length <= 100) {
            await page.keyboard.type(content, { delay: 8 });
        } else {
            await inputEl.evaluate((el, text) => {
                el.textContent = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(
                    new CompositionEvent('compositionend', { data: text, bubbles: true }),
                );
            }, content);
            await page.waitForTimeout(200);
        }

        console.log(`[Kimi] 输入完成: "${content.substring(0, 40)}..."`);
    }

    /**
     * 创建新对话页面
     * 根据 feature 导航到不同的 Kimi Agent 页面
     */
    async createNewChat(feature, conversationId) {
        const page = await this.browser.newPage();

        const pageInfo = { page, streamCallbacks: null };

        // 1) 暴露桥接函数 — 浏览器调用此函数将数据传给 Node.js
        await page.exposeFunction('__tunBridge', (type, data) => {
            if (!pageInfo.streamCallbacks) return;
            switch (type) {
                case 'chunk':
                    pageInfo.streamCallbacks.onRawChunk(data);
                    break;
                case 'end':
                    pageInfo.streamCallbacks.onStreamEnd();
                    break;
                case 'error':
                    pageInfo.streamCallbacks.onStreamError(data);
                    break;
            }
        });

        // 2) 注入 fetch 拦截器 — 在每次页面加载时自动运行
        await page.addInitScript(() => {
            const origFetch = window.fetch;
            window.fetch = async function (...args) {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                const response = await origFetch.apply(this, args);

                // 拦截 Kimi 的聊天 API
                if (url.includes('ChatService/Chat') && response.ok && response.body) {
                    // 克隆响应，原始的留给 Kimi 页面使用
                    const cloned = response.clone();
                    const reader = cloned.body.getReader();
                    const decoder = new TextDecoder('utf-8');

                    // 异步读取流
                    (async () => {
                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) {
                                    window.__tunBridge('end', '');
                                    break;
                                }
                                const text = decoder.decode(value, { stream: true });
                                if (text) {
                                    window.__tunBridge('chunk', text);
                                }
                            }
                        } catch (e) {
                            window.__tunBridge('error', e.message || 'stream read error');
                        }
                    })();
                }

                return response;
            };
        });

        // 3) 根据 feature 选择正确的 URL
        const featureUrls = {
            chat: 'https://www.kimi.com',
            'agent-website': 'https://www.kimi.com/websites',
            'agent-ppt': 'https://www.kimi.com/slides',
            'agent-doc': 'https://www.kimi.com/docs',
            'agent-sheet': 'https://www.kimi.com/sheets',
            'agent-research': 'https://www.kimi.com/research',
            'agent-code': 'https://www.kimi.com/code',
        };

        const targetUrl = featureUrls[feature] || 'https://www.kimi.com';
        console.log(`[Kimi] 打开 ${feature}: ${targetUrl}`);
        await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        await page.waitForTimeout(4000);

        const finalUrl = page.url();
        const title = await page.title();
        console.log(`[Kimi] 页面就绪: ${finalUrl} (${title})`);

        // 处理遮罩层
        await this.dismissOverlays(page);

        return pageInfo;
    }

    /**
     * 清理资源
     */
    async cleanup() {
        for (const { page } of this.pages.values()) {
            try {
                if (!page.isClosed()) await page.close();
            } catch (e) {
                /* ignore */
            }
        }
        this.pages.clear();
    }
}

module.exports = KimiProvider;
