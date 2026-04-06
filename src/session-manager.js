/**
 * 会话管理器
 * 管理用户连接和对话状态
 */

class SessionManager {
    constructor() {
        // username -> { ws, conversations: Map<convId, convData> }
        this.users = new Map();
    }

    addUser(username, ws) {
        if (this.users.has(username)) {
            // 同一用户重连，替换 ws
            const user = this.users.get(username);
            user.ws = ws;
        } else {
            this.users.set(username, {
                ws,
                conversations: new Map(),
            });
        }
    }

    removeUser(username) {
        // 保留会话数据但清除 ws 连接
        const user = this.users.get(username);
        if (user) {
            user.ws = null;
        }
    }

    getUser(username) {
        return this.users.get(username);
    }

    createConversation(username, convId, provider, feature) {
        const user = this.users.get(username);
        if (!user) return null;

        const conv = {
            id: convId,
            provider,
            feature,
            createdAt: Date.now(),
            lastActive: Date.now(),
            browserPageId: null, // 关联的浏览器页面 ID
        };

        user.conversations.set(convId, conv);
        return conv;
    }

    getConversation(username, convId) {
        const user = this.users.get(username);
        if (!user) return null;
        const conv = user.conversations.get(convId);
        if (conv) {
            conv.lastActive = Date.now();
        }
        return conv;
    }

    // 获取所有活跃的用户数
    getActiveUserCount() {
        let count = 0;
        for (const user of this.users.values()) {
            if (user.ws && user.ws.readyState === 1) count++;
        }
        return count;
    }

    // 获取所有活跃会话数
    getActiveConversationCount() {
        let count = 0;
        for (const user of this.users.values()) {
            count += user.conversations.size;
        }
        return count;
    }
}

module.exports = SessionManager;
