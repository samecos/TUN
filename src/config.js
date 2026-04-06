/**
 * TUN 配置文件
 * 所有可配置项集中管理
 */

const path = require("path");

module.exports = {
  // 服务器配置
  server: {
    host: "0.0.0.0", // 绑定所有内网接口
    port: 3210, // 服务端口
  },

  // 浏览器数据存储路径（登录状态、cookies 等）
  browserDataDir: path.join(__dirname, "..", "browser-data"),

  // 用户白名单（内网简单认证，输入用户名即可）
  // 留空则不限制
  allowedUsers: [
    // 'alice',
    // 'bob',
  ],

  // 服务提供商配置
  providers: {
    kimi: {
      name: "Kimi (Moonshot)",
      url: "https://www.kimi.com",
      enabled: true,
      maxSessions: 2, // 最大并发浏览器标签页
      sessionTimeout: 10 * 60 * 1000, // 10 分钟无活动回收
      features: [
        { id: "chat", name: "智能对话", description: "与 Kimi 进行对话" },
        {
          id: "agent-website",
          name: "网站生成 Agent",
          description: "用 Kimi Agent 生成网站",
        },
        {
          id: "agent-ppt",
          name: "PPT 生成 Agent",
          description: "用 Kimi Agent 生成 PPT",
        },
      ],
    },
    gemini: {
      name: "Google Gemini Ultra",
      url: "https://gemini.google.com",
      enabled: true,
      maxSessions: 2,
      sessionTimeout: 10 * 60 * 1000,
      features: [
        {
          id: "chat",
          name: "智能对话",
          description: "与 Gemini Ultra 进行对话",
        },
        {
          id: "image-gen",
          name: "图片生成",
          description: "用 Gemini 生成图片",
        },
        { id: "code", name: "代码执行", description: "Gemini 代码执行环境" },
      ],
    },
  },

  // 队列配置
  queue: {
    maxWaiting: 10, // 最大排队数
    requestTimeout: 15 * 60 * 1000, // 单次请求超时 5 分钟
  },
};
