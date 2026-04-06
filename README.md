# TUN - AI 服务网关

内网部署的 AI 服务透明代理，让受信任的用户无需登录即可使用 Kimi 和 Google Gemini Ultra 的网页端功能。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 首次设置（登录账号）

```bash
npm run setup
```

这会打开一个浏览器窗口，按提示分别登录 Kimi 和 Gemini 账号。登录状态会被保存到 `browser-data/` 目录。

### 3. 启动服务

```bash
npm start
```

服务启动后，内网用户可通过浏览器访问 `http://<你的IP>:3210`。

## 开发模式

```bash
npm run dev
```

开发模式下，如果没有配置浏览器登录状态，会自动使用模拟回复。

## 配置

编辑 `src/config.js` 可以修改：

- 服务端口
- 用户白名单
- 启用/禁用的服务
- 并发限制
- 超时设置

## 项目结构

```
TUN/
├── public/              # 前端静态文件
│   ├── index.html       # 主页面
│   ├── style.css        # 样式
│   └── app.js           # 前端逻辑
├── src/
│   ├── server.js        # 后端入口
│   ├── config.js        # 配置文件
│   ├── session-manager.js   # 会话管理
│   ├── browser-manager.js   # Playwright 浏览器管理
│   ├── setup-login.js       # 登录设置工具
│   └── providers/
│       ├── kimi.js      # Kimi 适配器
│       └── gemini.js    # Gemini 适配器
├── browser-data/        # 浏览器登录状态（自动生成）
└── package.json
```
