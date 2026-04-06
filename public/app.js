/**
 * TUN 前端应用逻辑
 * WebSocket 通信 + UI 交互
 */

(function () {
  'use strict';

  // --- State ---
  const state = {
    username: '',
    ws: null,
    connected: false,
    currentProvider: null,  // 'kimi' | 'gemini'
    currentFeature: null,   // feature id
    currentConversationId: null,
    conversations: [],      // [{id, provider, feature, title, messages}]
    providers: {},          // 从服务器获取的配置
    isWaiting: false,       // 正在等待 AI 回复
  };

  // --- DOM References ---
  const dom = {
    // Screens
    loginScreen: document.getElementById('login-screen'),
    mainScreen: document.getElementById('main-screen'),

    // Login
    usernameInput: document.getElementById('username-input'),
    loginBtn: document.getElementById('login-btn'),

    // Sidebar
    sidebarUsername: document.getElementById('sidebar-username'),
    providerList: document.getElementById('provider-list'),
    featureList: document.getElementById('feature-list'),
    conversationList: document.getElementById('conversation-list'),
    connectionStatus: document.getElementById('connection-status'),
    logoutBtn: document.getElementById('logout-btn'),

    // Chat
    welcomeView: document.getElementById('welcome-view'),
    chatView: document.getElementById('chat-view'),
    chatProviderBadge: document.getElementById('chat-provider-badge'),
    chatFeatureName: document.getElementById('chat-feature-name'),
    chatMessages: document.getElementById('chat-messages'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    newChatBtn: document.getElementById('new-chat-btn'),
    queueInfo: document.getElementById('queue-info'),
    queueText: document.getElementById('queue-text'),
    welcomeCards: document.getElementById('welcome-cards'),
  };

  // --- Init ---
  function init() {
    // 从 localStorage 恢复用户名
    const saved = localStorage.getItem('tun_username');
    if (saved) {
      state.username = saved;
      enterMainScreen();
    }

    bindEvents();
  }

  // --- Events ---
  function bindEvents() {
    // Login
    dom.loginBtn.addEventListener('click', handleLogin);
    dom.usernameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLogin();
    });

    // Logout
    dom.logoutBtn.addEventListener('click', handleLogout);

    // Chat input
    dom.messageInput.addEventListener('input', () => {
      autoResizeTextarea(dom.messageInput);
      dom.sendBtn.disabled = !dom.messageInput.value.trim() || state.isWaiting;
    });

    dom.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    dom.sendBtn.addEventListener('click', handleSend);
    dom.newChatBtn.addEventListener('click', handleNewChat);
  }

  // --- Login ---
  function handleLogin() {
    const username = dom.usernameInput.value.trim();
    if (!username) {
      dom.usernameInput.focus();
      return;
    }
    state.username = username;
    localStorage.setItem('tun_username', username);
    enterMainScreen();
  }

  function handleLogout() {
    state.username = '';
    localStorage.removeItem('tun_username');
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    dom.mainScreen.classList.remove('active');
    dom.loginScreen.classList.add('active');
  }

  // --- Main Screen ---
  function enterMainScreen() {
    dom.loginScreen.classList.remove('active');
    dom.mainScreen.classList.add('active');
    dom.sidebarUsername.textContent = state.username;
    connectWebSocket();
  }

  // --- WebSocket ---
  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws?user=${encodeURIComponent(state.username)}`;

    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      state.connected = true;
      updateConnectionStatus('connected');
    };

    state.ws.onclose = () => {
      state.connected = false;
      updateConnectionStatus('disconnected');
      // 自动重连
      setTimeout(() => {
        if (state.username) connectWebSocket();
      }, 3000);
    };

    state.ws.onerror = () => {
      updateConnectionStatus('disconnected');
    };

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };
  }

  function updateConnectionStatus(status) {
    const el = dom.connectionStatus;
    el.className = 'connection-status ' + status;
    const textEl = el.querySelector('.status-text');
    switch (status) {
      case 'connected': textEl.textContent = '已连接'; break;
      case 'disconnected': textEl.textContent = '已断开'; break;
      default: textEl.textContent = '连接中...';
    }
  }

  function send(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    }
  }

  // --- Server Message Handling ---
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'config':
        // 服务器发送可用的 providers 和 features
        state.providers = msg.providers;
        renderProviders();
        renderWelcomeCards();
        break;

      case 'chat_reply':
        // AI 回复（最终完整回复）
        finishAssistantMessage(msg.conversationId, msg.content);
        break;

      case 'chat_reply_chunk':
        // 流式回复片段
        appendToAssistantMessage(msg.conversationId, msg.chunk);
        break;

      case 'chat_reply_start':
        // 开始接收回复
        startAssistantMessage(msg.conversationId, msg.provider);
        break;

      case 'chat_reply_end':
        // 回复结束
        endAssistantMessage(msg.conversationId);
        break;

      case 'queue_position':
        showQueueInfo(msg.position);
        break;

      case 'queue_clear':
        hideQueueInfo();
        break;

      case 'error':
        showSystemMessage(msg.message, 'error');
        state.isWaiting = false;
        dom.sendBtn.disabled = !dom.messageInput.value.trim();
        removeTypingIndicator();
        break;

      case 'system':
        showSystemMessage(msg.message);
        break;

      default:
        console.warn('Unknown message type:', msg.type);
    }
  }

  // --- Render Providers ---
  function renderProviders() {
    dom.providerList.innerHTML = '';
    for (const [key, provider] of Object.entries(state.providers)) {
      const div = document.createElement('div');
      div.className = `provider-item${!provider.enabled ? ' disabled' : ''}`;
      div.dataset.provider = key;
      div.innerHTML = `
        <span class="provider-dot ${key}"></span>
        <span class="provider-name">${provider.name}</span>
        <span class="provider-status">${provider.enabled ? '可用' : '禁用'}</span>
      `;
      div.addEventListener('click', () => selectProvider(key));
      dom.providerList.appendChild(div);
    }
  }

  function selectProvider(key) {
    state.currentProvider = key;
    state.currentFeature = null;

    // Update active state
    dom.providerList.querySelectorAll('.provider-item').forEach(el => {
      el.classList.toggle('active', el.dataset.provider === key);
    });

    renderFeatures(key);
  }

  function renderFeatures(providerKey) {
    const provider = state.providers[providerKey];
    if (!provider) return;

    dom.featureList.innerHTML = '';
    for (const feature of provider.features) {
      const div = document.createElement('div');
      div.className = 'feature-item';
      div.dataset.feature = feature.id;
      div.textContent = feature.name;
      div.title = feature.description;
      div.addEventListener('click', () => selectFeature(providerKey, feature));
      dom.featureList.appendChild(div);
    }
  }

  function selectFeature(providerKey, feature) {
    state.currentFeature = feature.id;

    dom.featureList.querySelectorAll('.feature-item').forEach(el => {
      el.classList.toggle('active', el.dataset.feature === feature.id);
    });

    startNewChat(providerKey, feature);
  }

  // --- Welcome Cards ---
  function renderWelcomeCards() {
    dom.welcomeCards.innerHTML = '';
    for (const [key, provider] of Object.entries(state.providers)) {
      if (!provider.enabled) continue;
      for (const feature of provider.features) {
        const card = document.createElement('div');
        card.className = 'welcome-card';
        card.innerHTML = `
          <div class="welcome-card-provider ${key}">${provider.name}</div>
          <div class="welcome-card-title">${feature.name}</div>
          <div class="welcome-card-desc">${feature.description}</div>
        `;
        card.addEventListener('click', () => {
          selectProvider(key);
          selectFeature(key, feature);
        });
        dom.welcomeCards.appendChild(card);
      }
    }
  }

  // --- Chat ---
  function startNewChat(providerKey, feature) {
    const convId = generateId();
    const conv = {
      id: convId,
      provider: providerKey,
      feature: feature.id,
      featureName: feature.name,
      title: `${feature.name} - ${new Date().toLocaleTimeString()}`,
      messages: [],
    };

    state.conversations.unshift(conv);
    state.currentConversationId = convId;
    state.isWaiting = false;

    renderConversationList();
    showChatView(providerKey, feature.name);
    clearMessages();

    // 告诉服务器开启新对话
    send({
      type: 'new_chat',
      conversationId: convId,
      provider: providerKey,
      feature: feature.id,
    });
  }

  function handleNewChat() {
    if (!state.currentProvider || !state.currentFeature) return;
    const provider = state.providers[state.currentProvider];
    const feature = provider.features.find(f => f.id === state.currentFeature);
    if (feature) {
      startNewChat(state.currentProvider, feature);
    }
  }

  function showChatView(providerKey, featureName) {
    dom.welcomeView.classList.remove('active');
    dom.chatView.classList.add('active');
    dom.chatProviderBadge.textContent = providerKey;
    dom.chatProviderBadge.className = `chat-provider-badge ${providerKey}`;
    dom.chatFeatureName.textContent = featureName;
  }

  function handleSend() {
    const text = dom.messageInput.value.trim();
    if (!text || state.isWaiting || !state.currentConversationId) return;

    // 添加用户消息到 UI
    addMessage(state.currentConversationId, 'user', text);

    // 发送到服务器
    send({
      type: 'chat_message',
      conversationId: state.currentConversationId,
      content: text,
    });

    // 清空输入
    dom.messageInput.value = '';
    dom.messageInput.style.height = 'auto';
    dom.sendBtn.disabled = true;
    state.isWaiting = true;

    // 显示 typing indicator
    showTypingIndicator();
  }

  // --- Messages ---
  function addMessage(convId, role, content) {
    const conv = state.conversations.find(c => c.id === convId);
    if (conv) {
      conv.messages.push({ role, content, time: Date.now() });
      // 更新标题
      if (role === 'user' && conv.messages.filter(m => m.role === 'user').length === 1) {
        conv.title = content.substring(0, 30) + (content.length > 30 ? '...' : '');
        renderConversationList();
      }
    }

    if (convId === state.currentConversationId) {
      renderMessage(role, content, convId);
    }
  }

  function renderMessage(role, content, convId) {
    const conv = state.conversations.find(c => c.id === convId);
    const providerKey = conv ? conv.provider : '';

    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}`;

    const avatarClass = role === 'assistant' ? `message-avatar ${providerKey}` : 'message-avatar';
    const avatarLabel = role === 'user'
      ? state.username.charAt(0).toUpperCase()
      : (providerKey === 'kimi' ? 'K' : providerKey === 'gemini' ? 'G' : 'AI');

    const bubbleContent = role === 'assistant' ? renderMarkdown(content) : escapeHtml(content);
    msgEl.innerHTML = `
      <div class="${avatarClass}">${avatarLabel}</div>
      <div class="message-bubble markdown-body">${bubbleContent}</div>
    `;

    // 对已完成的消息做一次代码高亮
    if (role === 'assistant') {
      msgEl.querySelectorAll('pre code').forEach(block => {
        if (window.hljs) hljs.highlightElement(block);
      });
    }

    dom.chatMessages.appendChild(msgEl);
    scrollToBottom();
  }

  function startAssistantMessage(convId, provider) {
    removeTypingIndicator();
    if (convId !== state.currentConversationId) return;

    const msgEl = document.createElement('div');
    msgEl.className = 'message assistant';
    msgEl.id = `streaming-msg-${convId}`;

    const avatarLabel = provider === 'kimi' ? 'K' : provider === 'gemini' ? 'G' : 'AI';
    msgEl.innerHTML = `
      <div class="message-avatar ${provider}">${avatarLabel}</div>
      <div class="message-bubble markdown-body streaming-content" data-raw=""></div>
    `;

    dom.chatMessages.appendChild(msgEl);
    scrollToBottom();
  }

  // 流式渲染的节流控制
  let _renderTimer = null;
  let _lastRenderTime = 0;

  function appendToAssistantMessage(convId, chunk) {
    if (convId !== state.currentConversationId) return;
    const msgEl = document.getElementById(`streaming-msg-${convId}`);
    if (msgEl) {
      const bubble = msgEl.querySelector('.streaming-content');
      // 累加原始文本
      const raw = (bubble.getAttribute('data-raw') || '') + chunk;
      bubble.setAttribute('data-raw', raw);

      // 节流渲染：最多每 120ms 渲染一次 Markdown
      const now = Date.now();
      if (_renderTimer) clearTimeout(_renderTimer);

      if (now - _lastRenderTime > 120) {
        bubble.innerHTML = renderMarkdown(raw);
        _lastRenderTime = now;
        scrollToBottom();
      } else {
        _renderTimer = setTimeout(() => {
          bubble.innerHTML = renderMarkdown(raw);
          _lastRenderTime = Date.now();
          scrollToBottom();
        }, 120);
      }
    }
  }

  function endAssistantMessage(convId) {
    state.isWaiting = false;
    dom.sendBtn.disabled = !dom.messageInput.value.trim();
    if (_renderTimer) clearTimeout(_renderTimer);

    const msgEl = document.getElementById(`streaming-msg-${convId}`);
    if (msgEl) {
      const bubble = msgEl.querySelector('.streaming-content');
      const rawContent = bubble.getAttribute('data-raw') || bubble.textContent;

      // 最终完整渲染（带代码高亮）
      bubble.innerHTML = renderMarkdown(rawContent);
      bubble.querySelectorAll('pre code').forEach(block => {
        if (window.hljs) hljs.highlightElement(block);
      });

      bubble.classList.remove('streaming-content');
      bubble.removeAttribute('data-raw');
      msgEl.removeAttribute('id');

      // 保存到对话历史
      const conv = state.conversations.find(c => c.id === convId);
      if (conv) {
        conv.messages.push({ role: 'assistant', content: rawContent, time: Date.now() });
      }
    }
    scrollToBottom();
  }

  function finishAssistantMessage(convId, content) {
    removeTypingIndicator();
    state.isWaiting = false;
    dom.sendBtn.disabled = !dom.messageInput.value.trim();
    if (_renderTimer) clearTimeout(_renderTimer);

    // 检查是否存在流式消息元素
    const existingEl = document.getElementById(`streaming-msg-${convId}`);
    if (existingEl) {
      existingEl.removeAttribute('id');
      const bubble = existingEl.querySelector('.message-bubble');
      bubble.innerHTML = renderMarkdown(content);
      bubble.querySelectorAll('pre code').forEach(block => {
        if (window.hljs) hljs.highlightElement(block);
      });
      bubble.classList.remove('streaming-content');
      bubble.removeAttribute('data-raw');
    } else {
      addMessage(convId, 'assistant', content);
    }
  }

  function showTypingIndicator() {
    const existing = dom.chatMessages.querySelector('.typing-message');
    if (existing) return;

    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    const providerKey = conv ? conv.provider : '';
    const avatarLabel = providerKey === 'kimi' ? 'K' : providerKey === 'gemini' ? 'G' : 'AI';

    const msgEl = document.createElement('div');
    msgEl.className = 'message assistant typing-message';
    msgEl.innerHTML = `
      <div class="message-avatar ${providerKey}">${avatarLabel}</div>
      <div class="message-bubble">
        <div class="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
    dom.chatMessages.appendChild(msgEl);
    scrollToBottom();
  }

  function removeTypingIndicator() {
    const el = dom.chatMessages.querySelector('.typing-message');
    if (el) el.remove();
  }

  function showSystemMessage(text, type = '') {
    const el = document.createElement('div');
    el.className = `system-message ${type}`;
    el.textContent = text;
    dom.chatMessages.appendChild(el);
    scrollToBottom();
  }

  function clearMessages() {
    dom.chatMessages.innerHTML = '';
  }

  function showQueueInfo(position) {
    dom.queueInfo.style.display = 'flex';
    dom.queueText.textContent = `排队中 #${position}`;
  }

  function hideQueueInfo() {
    dom.queueInfo.style.display = 'none';
  }

  // --- Conversation List ---
  function renderConversationList() {
    if (state.conversations.length === 0) {
      dom.conversationList.innerHTML = '<div class="empty-hint">暂无会话</div>';
      return;
    }

    dom.conversationList.innerHTML = '';
    for (const conv of state.conversations) {
      const div = document.createElement('div');
      div.className = `conversation-item${conv.id === state.currentConversationId ? ' active' : ''}`;
      div.textContent = conv.title;
      div.addEventListener('click', () => switchConversation(conv.id));
      dom.conversationList.appendChild(div);
    }
  }

  function switchConversation(convId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;

    state.currentConversationId = convId;
    state.currentProvider = conv.provider;
    state.currentFeature = conv.feature;

    // Update sidebar
    dom.providerList.querySelectorAll('.provider-item').forEach(el => {
      el.classList.toggle('active', el.dataset.provider === conv.provider);
    });
    renderFeatures(conv.provider);
    dom.featureList.querySelectorAll('.feature-item').forEach(el => {
      el.classList.toggle('active', el.dataset.feature === conv.feature);
    });

    // Show chat
    showChatView(conv.provider, conv.featureName);
    clearMessages();

    // Re-render messages
    for (const msg of conv.messages) {
      renderMessage(msg.role, msg.content, convId);
    }

    renderConversationList();
  }

  // --- Utils ---
  function scrollToBottom() {
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  }

  function autoResizeTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * 将 Markdown 文本渲染为 HTML
   * 使用 marked.js，配置代码高亮和安全选项
   */
  function renderMarkdown(text) {
    if (!text) return '';
    if (typeof marked === 'undefined') return escapeHtml(text);

    // 清理 Kimi 的引用标记 [^1^] [^2^]...
    const cleaned = text.replace(/\[\^\d+\^\]/g, '');

    try {
      // 配置 marked
      marked.setOptions({
        breaks: true,        // 换行转 <br>
        gfm: true,           // GitHub Flavored Markdown
        highlight: function (code, lang) {
          if (window.hljs && lang && hljs.getLanguage(lang)) {
            try {
              return hljs.highlight(code, { language: lang }).value;
            } catch (e) { /* fallback */ }
          }
          if (window.hljs) {
            try {
              return hljs.highlightAuto(code).value;
            } catch (e) { /* fallback */ }
          }
          return code;
        },
      });

      return marked.parse(cleaned);
    } catch (e) {
      console.error('Markdown render error:', e);
      return escapeHtml(text);
    }
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  }

  // --- Start ---
  init();
})();
