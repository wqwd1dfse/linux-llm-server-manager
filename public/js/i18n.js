// Comprehensive Internationalization (i18n) Engine (Chinese / English)

import { staticPhrasePairs } from './i18nCatalog.js';

const translations = {
  'zh-CN': {
    // Navigation
    'nav.files': '远程文件系统 (SFTP)',
    'nav.terminal': 'Web 命令行终端 (SSH)',
    'nav.llm': '大模型控制台 (LLM Studio)',
    'nav.fan': '风扇与散热控制台 (Fan Control)',
    'nav.docker': 'Docker 容器与镜像',
    'nav.services': '进程与 Systemd 服务',
    'nav.scripts': '常用运维工具箱',
    'nav.mon_cpu': 'CPU 处理器监控',
    'nav.mon_gpu': 'GPU 显卡多卡监控',
    'nav.mon_ram': '内存 (RAM) 监控',
    'nav.mon_ssd': '磁盘 / SSD 存储',
    'nav.settings': '系统与偏好设置',

    // Top Header & Address Bar
    'header.title': 'Windows 控制台 · Linux 服务器管理',
    'header.connected': '已连接 (在线)',
    'header.disconnected': '未连接',
    'header.theme_dark': '深色模式',
    'header.theme_light': '浅色模式',
    'header.quick_access': '快速访问',
    'header.hardware_mon': '性能与硬件监控',
    'header.config_mgmt': '配置管理',
    'header.server_host': '此服务器',
    'cmd.new_folder': '📁 新建文件夹',
    'cmd.new_file': '📄 新建文件',
    'cmd.upload': '⬆ 上传文件',
    'cmd.refresh': '🔄 刷新 (F5)',
    'cmd.terminal': '⚡ 命令行终端',
    'cmd.settings': '🔑 连接配置',
    'cmd.search_ph': '在当前页面搜索...',

    // Fan View
    'fan.title': '风扇与全机散热控制台',
    'fan.service_status': '温控状态与策略',
    'fan.curves_title': '温度与功耗实时历史曲线',
    'fan.export_chart': '📸 导出图表',
    'fan.sample_rate': '● 实时采样 3s/次',
    'fan.preset_full': '100% 极速强冷',
    'fan.preset_auto': '智能自动温控',
    'fan.preset_quiet': '全机静音待机',
    'fan.matrix_title': '🌪️ 全机风扇转速与实时 PWM 占空比',
    'fan.sliders_title': '🎛️ 多路风扇独立手动 PWM 调速',
    'fan.apply_all': '⚡ 一键应用全部风扇转速设定',
    'fan.gpu_temps_title': 'GPU 计算卡温度与能耗',
    'fan.cpu_temps_title': 'CPU 处理器与核心温度',
    'fan.disk_temps_title': '磁盘与固态硬盘温度 (SMART)',
    'fan.sys_temps_title': '主板温区与网络芯片',

    // LLM Studio
    'llm.tab_chat': '💬 AI 对话体验 (Chat Studio)',
    'llm.tab_hf': '🤗 Hugging Face 云端模型库',
    'llm.tab_local': '📦 本地模型与存储管理 (/mnt/models)',
    'llm.tab_tasks': '⬇️ 下载任务管理器',
    'llm.rate': '⚡ 推理速率',
    'llm.ttft': '⏱️ 首字耗时 (TTFT)',
    'llm.token_count': '📊 已生成 Token',
    'llm.benchmarks': '⚡ 快速测试',
    'llm.bench_code': '🐍 Python 算法',
    'llm.bench_reasoning': '🧠 逻辑推理',
    'llm.bench_speed': '🚀 极速长文测速',
    'llm.send': '发送',
    'llm.stop': '中止',
    'llm.clear': '清屏',
    'llm.start_server': '🚀 启动服务',
    'llm.logs': '📋 日志',
    'llm.search_placeholder': '在 Hugging Face 搜索开源模型 (如: Qwen2.5, DeepSeek-R1, Llama-3.1)...',
    'llm.search_btn': '🔍 搜索模型',
    'llm.mirror_toggle': '⚡ 启用国内极速镜像 (hf-mirror.com)',
    'llm.local_refresh': '🔄 刷新本地模型库',
    'llm.start_custom': '➕ 启动自定义模型',
    'llm.filter_local': '🔍 快速搜索本地模型名称 / 量化等级...',

    // Settings View
    'settings.title': '⚙️ 系统与客户端偏好设置',
    'settings.subtitle': '统一管理语言本地化、外观主题、采样频率、HF 模型库与 SSH 连接',
    'settings.save_btn': '💾 保存所有设置',
    'settings.lang_title': '🌐 界面显示语言 (Language)',
    'settings.lang_label': '选择当前客户端语言 / Select Language',
    'settings.lang_note': '支持即时免刷新多语言切换，覆盖全控制台所有功能模块。',
    'settings.theme_title': '🎨 主题与视觉样式',
    'settings.theme_label': '色彩模式',
    'settings.theme_note': 'Windows 11 Fluent 亚克力磨砂玻璃质感与 HSL 精校调色盘。',
    'settings.perf_title': '⏱️ 实时监控轮询刷新周期',
    'settings.perf_label': '数据更新频率',
    'settings.perf_note': '控制风扇、温度历史曲线及系统硬件仪表盘的自动拉取周期。',
    'settings.alarm_title': '🚨 硬件温控警戒阈值',
    'settings.alarm_label': '警戒线温度 (°C)',
    'settings.alarm_note': '图表中的警戒参考线将动态吸附到该温度设定。',
    'settings.hf_title': '🤗 Hugging Face Hub 全局偏好与镜像',
    'settings.hf_mirror': '⚡ 默认启用国内高速镜像源 (hf-mirror.com)',
    'settings.hf_token_label': 'Hugging Face 官方 Access Token (用于下载受限模型)',
    'settings.hf_dir_label': '默认本地模型下载与存储目录 (Target Directory)',
    'settings.ssh_title': '🔐 目标服务器 SSH 连接参数',
    'settings.ssh_host_label': '目标主机 IP 地址 (Host)',
    'settings.ssh_port_label': 'SSH 服务端口 (Port)',
    'settings.ssh_user_label': '登录用户名 (Username)',
    'settings.ssh_auth_label': '身份认证方式 (Authentication)',
    'settings.ssh_pwd_label': '登录密码 (Password)',
    'settings.ssh_key_label': '私钥文本 (id_rsa / id_ed25519)',
    'settings.ssh_test_btn': '测试连接',
    'settings.ssh_remember': '在这台管理机上保存 SSH 凭据（未勾选时仅保留到本次进程结束）',
    'settings.ssh_connect_btn': '建立 SSH 会话',

    // Docker & System
    'docker.title': 'Docker 容器与镜像',
    'docker.pull_modal': '拉取新镜像',
    'docker.refresh': '刷新容器',
    'services.proc_title': '正在运行的进程 (按 CPU/内存占用)',
    'services.systemd_title': 'Systemd 系统服务列表',
    'scripts.title': '一键常用维护脚本',
    'scripts.custom_title': '自定义 Shell 指令执行控制台',
    'scripts.run_btn': '执行命令',
    'cpu.title': 'CPU 处理器架构与负载',
    'gpu.title': 'GPU 显卡多卡详细监控',
    'ram.title': '内存 (RAM) 监控',
    'ssd.title': 'SSD / 磁盘实时 I/O 吞吐速度'
  },

  'en-US': {
    // Navigation
    'nav.files': 'Remote Filesystem (SFTP)',
    'nav.terminal': 'Web Terminal (SSH)',
    'nav.llm': 'LLM Studio & Inference',
    'nav.fan': 'Fan & Cooling Console',
    'nav.docker': 'Docker Containers & Images',
    'nav.services': 'Processes & Systemd Services',
    'nav.scripts': 'DevOps Toolbox & Scripts',
    'nav.mon_cpu': 'CPU Processor Monitor',
    'nav.mon_gpu': 'GPU Multi-Card Monitor',
    'nav.mon_ram': 'Memory (RAM) Monitor',
    'nav.mon_ssd': 'Disk / SSD Storage',
    'nav.settings': 'System & Preferences',

    // Top Header & Address Bar
    'header.title': 'Windows Console · Linux Server Manager',
    'header.connected': 'Connected (Online)',
    'header.disconnected': 'Disconnected',
    'header.theme_dark': 'Dark Mode',
    'header.theme_light': 'Light Mode',
    'header.quick_access': 'Quick Access',
    'header.hardware_mon': 'Hardware & Performance',
    'header.config_mgmt': 'Configuration',
    'header.server_host': 'This Server',
    'cmd.new_folder': '📁 New Folder',
    'cmd.new_file': '📄 New File',
    'cmd.upload': '⬆ Upload File',
    'cmd.refresh': '🔄 Refresh (F5)',
    'cmd.terminal': '⚡ Web Terminal',
    'cmd.settings': '🔑 Connection Profile',
    'cmd.search_ph': 'Search current page...',

    // Fan View
    'fan.title': 'Fan & Multi-Component Thermal Console',
    'fan.service_status': 'Thermal Policy & Daemon',
    'fan.curves_title': 'Real-Time Temperature & Power Curves',
    'fan.export_chart': '📸 Export Chart',
    'fan.sample_rate': '● Sample Rate 3s',
    'fan.preset_full': '100% Full Speed',
    'fan.preset_auto': 'Smart Auto Thermal',
    'fan.preset_quiet': 'Quiet Low-Noise',
    'fan.matrix_title': '🌪️ Fan Speeds & Real-Time PWM Duty Cycle',
    'fan.sliders_title': '🎛️ Independent Manual PWM Sliders',
    'fan.apply_all': '⚡ Apply All Fan Speeds',
    'fan.gpu_temps_title': 'GPU Accelerator Thermals & Power',
    'fan.cpu_temps_title': 'CPU Processor & Cores Thermals',
    'fan.disk_temps_title': 'Disk & SSD SMART Thermals',
    'fan.sys_temps_title': 'Motherboard & System Sensors',

    // LLM Studio
    'llm.tab_chat': '💬 AI Chat Studio & Playground',
    'llm.tab_hf': '🤗 Hugging Face Hub Explorer',
    'llm.tab_local': '📦 Local Models & Storage (/mnt/models)',
    'llm.tab_tasks': '⬇️ Download Task Queue',
    'llm.rate': '⚡ Token Speed',
    'llm.ttft': '⏱️ TTFT Latency',
    'llm.token_count': '📊 Generated Tokens',
    'llm.benchmarks': '⚡ Benchmarks',
    'llm.bench_code': '🐍 Python Code',
    'llm.bench_reasoning': '🧠 Reasoning',
    'llm.bench_speed': '🚀 Speed Test',
    'llm.send': 'Send',
    'llm.stop': 'Stop',
    'llm.clear': 'Clear',
    'llm.start_server': '🚀 Start Server',
    'llm.logs': '📋 Logs',
    'llm.search_placeholder': 'Search Hugging Face models (e.g., Qwen2.5, DeepSeek-R1, Llama-3.1)...',
    'llm.search_btn': '🔍 Search Models',
    'llm.mirror_toggle': '⚡ Enable Fast Mirror (hf-mirror.com)',
    'llm.local_refresh': '🔄 Refresh Models',
    'llm.start_custom': '➕ Launch Custom Model',
    'llm.filter_local': '🔍 Filter model name / quantization...',

    // Settings View
    'settings.title': '⚙️ System & Client Preferences',
    'settings.subtitle': 'Manage display language, visual theme, telemetry polling, Hugging Face hub, and SSH profile.',
    'settings.save_btn': '💾 Save Preferences',
    'settings.lang_title': '🌐 Display Language',
    'settings.lang_label': 'Select Client Interface Language',
    'settings.lang_note': 'Instant seamless zero-reload language switching across the entire console.',
    'settings.theme_title': '🎨 Theme & Visual Style',
    'settings.theme_label': 'Color Mode',
    'settings.theme_note': 'Windows 11 Fluent Acrylic backdrop with fine-tuned HSL palette.',
    'settings.perf_title': '⏱️ Real-time Telemetry Polling Interval',
    'settings.perf_label': 'Data Refresh Frequency',
    'settings.perf_note': 'Adjust polling frequency for fan telemetry, temperature charts, and hardware dashboard.',
    'settings.alarm_title': '🚨 Thermal Alert Threshold',
    'settings.alarm_label': 'Critical Alert Temperature (°C)',
    'settings.alarm_note': 'Chart alarm reference line will dynamically lock to this temperature setting.',
    'settings.hf_title': '🤗 Hugging Face Hub Defaults & Mirror',
    'settings.hf_mirror': '⚡ Default to Domestic Accelerated Mirror (hf-mirror.com)',
    'settings.hf_token_label': 'Hugging Face Access Token (for gated models like Llama-3 / Gemma)',
    'settings.hf_dir_label': 'Default Local Model Storage Directory (Target Directory)',
    'settings.ssh_title': '🔐 SSH Target Server Connection Profile',
    'settings.ssh_host_label': 'Target Host IP Address (Host)',
    'settings.ssh_port_label': 'SSH Server Port (Port)',
    'settings.ssh_user_label': 'Login Username (Username)',
    'settings.ssh_auth_label': 'Authentication Method',
    'settings.ssh_pwd_label': 'Login Password (Password)',
    'settings.ssh_key_label': 'Private Key (id_rsa / id_ed25519)',
    'settings.ssh_test_btn': 'Test Connection',
    'settings.ssh_remember': 'Save SSH credentials on this manager (otherwise keep them only for this process)',
    'settings.ssh_connect_btn': 'Connect SSH',

    // Docker & System
    'docker.title': 'Docker Containers & Images',
    'docker.pull_modal': 'Pull New Image',
    'docker.refresh': 'Refresh Containers',
    'services.proc_title': 'Running Processes (by CPU / Memory)',
    'services.systemd_title': 'Systemd Services List',
    'scripts.title': 'DevOps Toolbox & Preset Scripts',
    'scripts.custom_title': 'Custom Shell Command Console',
    'scripts.run_btn': 'Execute',
    'cpu.title': 'CPU Architecture & Load',
    'gpu.title': 'GPU Multi-Card Detailed Telemetry',
    'ram.title': 'Memory (RAM) Telemetry',
    'ssd.title': 'SSD & Disk Real-time I/O Throughput'
  }
};

// General bilingual phrase replacement table for dynamic/static elements without data-i18n
const phrasePairs = [
  ['远程文件系统 (SFTP)', 'Remote Filesystem (SFTP)'],
  ['Web 终端 (SSH)', 'Web Terminal (SSH)'],
  ['大模型控制台 (LLM)', 'LLM Studio & Inference'],
  ['大模型控制台 (LLM Studio)', 'LLM Studio & Inference'],
  ['风扇与散热控制', 'Fan & Cooling Console'],
  ['风扇与散热控制台 (Fan Control)', 'Fan & Cooling Console'],
  ['Docker 容器与镜像', 'Docker Containers & Images'],
  ['进程与系统服务', 'Processes & Systemd Services'],
  ['常用运维工具箱', 'DevOps Toolbox & Scripts'],
  ['CPU 处理器监控', 'CPU Processor Monitor'],
  ['GPU 显卡监控', 'GPU Multi-Card Monitor'],
  ['GPU 显卡多卡监控', 'GPU Multi-Card Monitor'],
  ['内存 (RAM) 监控', 'Memory (RAM) Monitor'],
  ['磁盘 / SSD 存储', 'Disk / SSD Storage'],
  ['系统与偏好设置', 'System & Preferences'],
  ['快速访问 / Navigation', 'Quick Access / Navigation'],
  ['快速访问', 'Quick Access'],
  ['性能与硬件监控', 'Hardware & Performance'],
  ['配置管理', 'Configuration Management'],
  ['100% 极速强冷', '100% Full Speed'],
  ['智能自动温控', 'Smart Auto Thermal'],
  ['全机静音待机', 'Quiet Low-Noise'],
  ['📸 导出图表', '📸 Export Chart'],
  ['⚡ 一键应用全部风扇转速设定', '⚡ Apply All Fan Speeds'],
  ['保存所有设置', 'Save Preferences'],
  ['保存并建立 SSH 会话', 'Save & Connect SSH'],
  ['测试连接', 'Test Connection'],
  ['刷新容器', 'Refresh Containers'],
  ['拉取新镜像', 'Pull New Image'],
  ['刷新', 'Refresh'],
  ['执行命令', 'Execute Command'],
  ['发送', 'Send'],
  ['中止', 'Stop'],
  ['清屏', 'Clear'],
  ['关闭', 'Close'],
  ['取消', 'Cancel'],
  ['确定', 'Confirm'],
  ['刷新本地模型库', 'Refresh Local Models'],
  ['启动自定义模型', 'Launch Custom Model'],
  ['打开仓库文件 ➔', 'Browse Repo Files ➔'],
  ['密码认证 (Password)', 'Password Authentication (Password)'],
  ['SSH 私钥认证 (Private Key)', 'Private Key Authentication (Private Key)'],
  ['深色模式 (Dark Theme - Fluent Dark)', 'Dark Theme (Fluent Dark)'],
  ['浅色模式 (Light Theme - Fluent Light)', 'Light Theme (Fluent Light)']
];

const DEFAULT_LANGUAGE = 'en-US';
const SUPPORTED_LANGUAGES = new Set(['en-US', 'zh-CN']);
const allPhrasePairs = [...phrasePairs, ...staticPhrasePairs];
const enByZh = new Map(allPhrasePairs);
const zhByEn = new Map(allPhrasePairs.map(([zh, en]) => [en, zh]));
const templatePhrasePairs = allPhrasePairs.filter(([zh]) => zh.length >= 4 || /[:：]$/.test(zh));
const replacePairs = {
  'en-US': [...templatePhrasePairs].sort((a, b) => b[0].length - a[0].length),
  'zh-CN': templatePhrasePairs.map(([zh, en]) => [en, zh]).sort((a, b) => b[0].length - a[0].length)
};

let currentLang = normalizeLanguage(localStorage.getItem('win-lang'));
let initialized = false;
let translating = false;
let observer = null;

function normalizeLanguage(lang) {
  return SUPPORTED_LANGUAGES.has(lang) ? lang : DEFAULT_LANGUAGE;
}

export function getLanguage() {
  return currentLang;
}

export function isEnglish() {
  return currentLang === 'en-US';
}

export function t(key) {
  const dict = translations[currentLang] || translations[DEFAULT_LANGUAGE];
  return dict[key] || translations[DEFAULT_LANGUAGE][key] || translations['zh-CN'][key] || key;
}

export function localize(zhText, enText) {
  return currentLang === 'zh-CN' ? zhText : enText;
}

export function localizeText(value, lang = currentLang) {
  if (value === null || value === undefined) return '';
  let result = String(value);
  for (const [fromText, toText] of replacePairs[normalizeLanguage(lang)]) {
    if (fromText && result.includes(fromText)) {
      result = result.split(fromText).join(toText);
    }
  }
  return result;
}

function translateExact(value) {
  const raw = String(value ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  const translated = currentLang === 'en-US' ? enByZh.get(trimmed) : zhByEn.get(trimmed);
  if (!translated || translated === trimmed) return raw;

  const start = raw.indexOf(trimmed);
  return raw.slice(0, start) + translated + raw.slice(start + trimmed.length);
}

function translateNodeValue(node) {
  const exact = translateExact(node.textContent);
  if (exact !== node.textContent) return exact;

  const parent = node.parentElement;
  const dynamicUi = parent && (
    parent.matches('button, option, [role="status"]') ||
    /^(status|fan-|llm-|docker-|server-|titlebar-|address-)/.test(parent.id || '')
  );
  return dynamicUi ? localizeText(node.textContent) : node.textContent;
}

function setElementTextPreservingChildren(element, value) {
  const directTextNodes = [...element.childNodes].filter(
    (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
  );

  if (directTextNodes.length) {
    directTextNodes[0].textContent = translateExact(value);
    for (const extraNode of directTextNodes.slice(1)) extraNode.textContent = '';
    return;
  }

  if (!element.children.length) {
    element.textContent = value;
    return;
  }

  element.insertBefore(document.createTextNode(value + ' '), element.firstChild);
}

function collectElements(root, selector) {
  const elements = [];
  if (root instanceof Element && root.matches(selector)) elements.push(root);
  if (root.querySelectorAll) elements.push(...root.querySelectorAll(selector));
  return elements;
}

function shouldSkipTextNode(node) {
  const parent = node.parentElement;
  return !parent || Boolean(parent.closest(
    'script, style, code, pre, textarea, [contenteditable=\"true\"], [data-i18n-skip], .win-code-editor, .markdown-body, .xterm'
  ));
}

function applyCatalogTranslations(root) {
  const walkerRoot = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
  if (!walkerRoot) return;

  const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    if (shouldSkipTextNode(node) || node.parentElement?.closest('[data-i18n]')) continue;
    const translated = translateNodeValue(node);
    if (translated !== node.textContent) node.textContent = translated;
  }

  for (const element of collectElements(walkerRoot, '[placeholder], [title], [aria-label]')) {
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      if (!element.hasAttribute(attribute)) continue;
      const current = element.getAttribute(attribute);
      const translated = translateExact(current);
      if (translated !== current) element.setAttribute(attribute, translated);
    }
  }
}

export function applyTranslations(root = document) {
  if (translating) return;
  translating = true;

  try {
    document.documentElement.lang = currentLang === 'en-US' ? 'en' : 'zh-CN';
    document.title = localize('Linux 服务器管理控制台', 'Linux Server Manager');

    const description = document.querySelector('meta[name=\"description\"]');
    if (description) {
      description.content = localize(
        '轻量、安全的 Linux 与本地大模型服务器管理控制台',
        'A lightweight and secure dashboard for Linux servers and local LLM systems'
      );
    }

    for (const element of collectElements(root, '[data-i18n]')) {
      const translated = t(element.getAttribute('data-i18n'));
      if (translated) setElementTextPreservingChildren(element, translated);
    }

    for (const element of collectElements(root, '[data-i18n-ph]')) {
      const translated = t(element.getAttribute('data-i18n-ph'));
      if (translated) element.setAttribute('placeholder', translated);
    }

    applyCatalogTranslations(root);

    const langSelect = document.getElementById('setting-lang-select');
    if (langSelect) langSelect.value = currentLang;
  } finally {
    translating = false;
  }
}

function startObserver() {
  if (observer || !document.body) return;

  observer = new MutationObserver((mutations) => {
    if (translating) return;
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const node = mutation.target;
        if (!shouldSkipTextNode(node) && !node.parentElement?.closest('[data-i18n]')) {
          const translated = translateNodeValue(node);
          if (translated !== node.textContent) node.textContent = translated;
        }
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          applyTranslations(node.nodeType === Node.TEXT_NODE ? node.parentElement : node);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function wrapNativeDialogs() {
  if (window.__i18nDialogsWrapped) return;
  window.__i18nDialogsWrapped = true;

  const nativeConfirm = window.confirm.bind(window);
  const nativePrompt = window.prompt.bind(window);
  window.confirm = (message) => nativeConfirm(localizeText(message));
  window.prompt = (message, defaultValue) => defaultValue === undefined
    ? nativePrompt(localizeText(message))
    : nativePrompt(localizeText(message), defaultValue);
}

export function setLanguage(lang, options = {}) {
  const normalized = normalizeLanguage(lang);
  if (lang !== normalized) return false;

  const previousLanguage = currentLang;
  currentLang = normalized;
  localStorage.setItem('win-lang', normalized);
  applyTranslations();

  window.dispatchEvent(new CustomEvent('languagechange', {
    detail: { language: currentLang, previousLanguage }
  }));

  if (options.announce !== false && previousLanguage !== currentLang && window.toast) {
    window.toast(localize('已切换至简体中文', 'Switched to English (US)'), 'success');
  }
  return true;
}

export function initI18n() {
  applyTranslations();
  if (initialized) return;

  initialized = true;
  const langSelect = document.getElementById('setting-lang-select');
  langSelect?.addEventListener('change', (event) => setLanguage(event.target.value));

  wrapNativeDialogs();
  startObserver();
}

window.t = t;
window.localize = localize;
window.localizeText = localizeText;
window.getLanguage = getLanguage;
window.isEnglish = isEnglish;
window.setLanguage = setLanguage;
window.initI18n = initI18n;
window.applyTranslations = applyTranslations;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initI18n, { once: true });
} else {
  initI18n();
}
