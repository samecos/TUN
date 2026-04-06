/**
 * TUN 后端服务器
 * Express + WebSocket
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const config = require('./config');
const SessionManager = require('./session-manager');
const BrowserManager = require('./browser-manager');

const app = express();
const server = http.createServer(app);

// --- 静态文件 ---
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- API: 健康检查 ---
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// --- API: 调试截图 ---
app.get('/api/debug/screenshot', async (req, res) => {
    if (!browserManager || !browserManager.isReady()) {
        return res.status(503).json({ error: 'Browser not ready' });
    }
    try {
        const pages = browserManager.browser.pages();
        const results = [];
        for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            const url = p.url();
            if (url === 'about:blank') continue;
            const screenshot = await p.screenshot({ type: 'png' });
            results.push({ index: i, url, screenshot: screenshot.toString('base64') });
        }
        res.json({ pages: results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API: 调试 DOM ---
app.get('/api/debug/dom', async (req, res) => {
    if (!browserManager || !browserManager.isReady()) {
        return res.status(503).json({ error: 'Browser not ready' });
    }
    try {
        const pages = browserManager.browser.pages();
        const results = [];
        for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            const url = p.url();
            if (url === 'about:blank') continue;
            const domInfo = await p.evaluate(() => {
                // 收集所有有用的 DOM 信息
                const info = {};

                // 所有 contenteditable 元素
                info.contentEditables = Array.from(
                    document.querySelectorAll('[contenteditable="true"]'),
                ).map((el) => ({
                    tag: el.tagName,
                    class: el.className.substring(0, 100),
                    id: el.id,
                }));

                // 所有按钮
                info.buttons = Array.from(document.querySelectorAll('button')).map((el) => ({
                    text: el.textContent.trim().substring(0, 50),
                    class: el.className.substring(0, 100),
                    ariaLabel: el.getAttribute('aria-label'),
                    disabled: el.disabled,
                }));

                // 所有 textarea
                info.textareas = Array.from(document.querySelectorAll('textarea')).map((el) => ({
                    class: el.className.substring(0, 100),
                    placeholder: el.placeholder,
                }));

                // 遮罩层
                info.masks = Array.from(
                    document.querySelectorAll('.mask, [class*="overlay"], [class*="modal"]'),
                ).map((el) => ({
                    tag: el.tagName,
                    class: el.className.substring(0, 100),
                    visible: el.offsetWidth > 0,
                }));

                // 消息容器候选
                const msgSelectors = [
                    '[class*="message"]',
                    '[class*="chat"]',
                    '[class*="segment"]',
                    '[class*="response"]',
                    '[class*="answer"]',
                    '[class*="reply"]',
                    '[data-role]',
                    '.markdown-body',
                ];
                info.messageContainers = {};
                for (const sel of msgSelectors) {
                    const count = document.querySelectorAll(sel).length;
                    if (count > 0) {
                        info.messageContainers[sel] = count;
                        // 获取最后一个元素的文本片段
                        const last = document.querySelectorAll(sel);
                        const lastEl = last[last.length - 1];
                        if (lastEl && lastEl.textContent.trim()) {
                            info.messageContainers[sel + '_lastText'] = lastEl.textContent
                                .trim()
                                .substring(0, 100);
                        }
                    }
                }

                return info;
            });
            results.push({ index: i, url, dom: domInfo });
        }
        res.json({ pages: results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- WebSocket ---
const wss = new WebSocketServer({ noServer: true });
const sessionManager = new SessionManager();
let browserManager = null;

// 手动处理 WebSocket 升级请求，避免 path 匹配导致 404
server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const username = url.searchParams.get('user') || 'anonymous';

    // 白名单检查
    if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(username)) {
        ws.send(JSON.stringify({ type: 'error', message: '你不在白名单中，无法使用此服务' }));
        ws.close();
        return;
    }

    console.log(`[WS] 用户 "${username}" 已连接`);

    // 注册用户连接
    sessionManager.addUser(username, ws);

    // 发送配置信息
    ws.send(
        JSON.stringify({
            type: 'config',
            providers: config.providers,
        }),
    );

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            await handleClientMessage(username, ws, msg);
        } catch (err) {
            console.error(`[WS] 消息处理错误:`, err);
            ws.send(JSON.stringify({ type: 'error', message: '消息处理失败: ' + err.message }));
        }
    });

    ws.on('close', () => {
        console.log(`[WS] 用户 "${username}" 已断开`);
        sessionManager.removeUser(username);
    });
});

// --- 消息处理 ---
async function handleClientMessage(username, ws, msg) {
    switch (msg.type) {
        case 'new_chat': {
            console.log(
                `[Chat] ${username} 开启新对话: ${msg.provider}/${msg.feature} (${msg.conversationId})`,
            );
            sessionManager.createConversation(
                username,
                msg.conversationId,
                msg.provider,
                msg.feature,
            );

            ws.send(
                JSON.stringify({
                    type: 'system',
                    message: `已连接到 ${config.providers[msg.provider]?.name || msg.provider} - ${msg.feature}`,
                }),
            );
            break;
        }

        case 'chat_message': {
            const conv = sessionManager.getConversation(username, msg.conversationId);
            if (!conv) {
                ws.send(JSON.stringify({ type: 'error', message: '会话不存在，请新建对话' }));
                return;
            }

            console.log(
                `[Chat] ${username} -> ${conv.provider}/${conv.feature}: ${msg.content.substring(0, 50)}...`,
            );

            // 如果浏览器管理器可用，发送到真实的 AI 服务
            if (browserManager && browserManager.isReady()) {
                try {
                    await browserManager.sendMessage(
                        conv.provider,
                        conv.feature,
                        msg.content,
                        msg.conversationId,
                        {
                            onStart: () => {
                                ws.send(
                                    JSON.stringify({
                                        type: 'chat_reply_start',
                                        conversationId: msg.conversationId,
                                        provider: conv.provider,
                                    }),
                                );
                            },
                            onChunk: (chunk) => {
                                ws.send(
                                    JSON.stringify({
                                        type: 'chat_reply_chunk',
                                        conversationId: msg.conversationId,
                                        chunk,
                                    }),
                                );
                            },
                            onEnd: () => {
                                ws.send(
                                    JSON.stringify({
                                        type: 'chat_reply_end',
                                        conversationId: msg.conversationId,
                                    }),
                                );
                            },
                            onError: (error) => {
                                ws.send(JSON.stringify({ type: 'error', message: error }));
                            },
                        },
                    );
                } catch (err) {
                    ws.send(
                        JSON.stringify({ type: 'error', message: '发送消息失败: ' + err.message }),
                    );
                }
            } else {
                // 开发模式：模拟回复
                simulateReply(ws, msg.conversationId, conv.provider, msg.content);
            }
            break;
        }

        default:
            console.warn(`[WS] 未知消息类型: ${msg.type}`);
    }
}

// --- 模拟回复（开发/测试用）---
function simulateReply(ws, conversationId, provider, userMessage) {
    const providerName = provider === 'kimi' ? 'Kimi' : 'Gemini';
    const reply = `[模拟回复] 你好！我是 ${providerName} 的模拟响应。\n\n你发送的消息是: "${userMessage}"\n\n⚠️ 这是开发模式的模拟回复。当 Playwright 浏览器管理器启动后，消息将被转发到真实的 ${providerName} 服务。\n\n要启用真实服务，请运行: npm run setup`;

    // 模拟流式回复
    ws.send(
        JSON.stringify({
            type: 'chat_reply_start',
            conversationId,
            provider,
        }),
    );

    const words = reply.split('');
    let i = 0;
    const interval = setInterval(() => {
        const chunk = words.slice(i, i + 3).join('');
        if (i >= words.length) {
            clearInterval(interval);
            ws.send(
                JSON.stringify({
                    type: 'chat_reply_end',
                    conversationId,
                }),
            );
            return;
        }

        ws.send(
            JSON.stringify({
                type: 'chat_reply_chunk',
                conversationId,
                chunk,
            }),
        );

        i += 3;
    }, 30);
}

// --- 启动 ---
async function start() {
    const { host, port } = config.server;

    // 尝试初始化浏览器管理器
    try {
        browserManager = new BrowserManager();
        const ready = await browserManager.initialize();
        if (ready) {
            console.log('[Browser] 浏览器管理器已就绪');
        } else {
            console.log('[Browser] 浏览器管理器初始化失败，将使用模拟模式');
            browserManager = null;
        }
    } catch (err) {
        console.log(`[Browser] 浏览器管理器不可用 (${err.message})，将使用模拟模式`);
        browserManager = null;
    }

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`\n  ❌ 端口 ${port} 已被占用！`);
            console.error(`  请先关闭占用该端口的进程，或修改 src/config.js 中的端口号\n`);
        } else {
            console.error('[Server] 启动错误:', err);
        }
        process.exit(1);
    });

    server.listen(port, host, () => {
        console.log('');
        console.log('  ╔══════════════════════════════════════╗');
        console.log('  ║       TUN - AI 服务网关              ║');
        console.log('  ╠══════════════════════════════════════╣');
        console.log(`  ║  地址: http://${host}:${port}        ║`);
        console.log(`  ║  模式: ${browserManager ? '🟢 实时代理' : '🟡 模拟模式'}            ║`);
        console.log('  ╚══════════════════════════════════════╝');
        console.log('');
    });
}

// 优雅关闭
process.on('SIGINT', async () => {
    console.log('\n[Server] 正在关闭...');
    if (browserManager) {
        await browserManager.cleanup();
    }
    server.close();
    process.exit(0);
});

start();
