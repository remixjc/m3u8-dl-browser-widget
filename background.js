import {
  DEFAULT_SETTINGS, buildHandoffUrl, buildTask, httpUrl, inferName,
  downloadHeaders, isPlaylistUrl, serverBase,
} from './core.js';

let settings = { ...DEFAULT_SETTINGS };
const ready = chrome.storage.local.get('settings').then(data => {
  settings = { ...DEFAULT_SETTINGS, ...data.settings };
});
const requests = new Map();
const queues = new Map();

function serial(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}
const keyFor = id => `captures:${id}`;
const pendingFor = id => `handoff:${id}`;
const getCaptures = async id =>
  ((await chrome.storage.session.get(keyFor(id)))[keyFor(id)] || []).filter(item => isPlaylistUrl(item.url));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  }
});

chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  if (details.tabId < 0 || !isPlaylistUrl(details.url)) return;
  const context = {
    tabId: details.tabId, url: details.url, documentUrl: details.documentUrl,
    timestamp: Date.now(),
    pageSnapshot: chrome.tabs.get(details.tabId).then(tab => ({ url: tab.url, title: tab.title })).catch(() => null),
  };
  requests.set(details.requestId, context);
  // 只为 playlist.m3u8 保留短期页面上下文，不读取浏览器请求头。
  for (const [id, request] of requests) {
    if (requests.size > 500 || request.timestamp < Date.now() - 60000) requests.delete(id);
    else break;
  }
}, { urls: ['http://*/*', 'https://*/*'] });

chrome.webRequest.onHeadersReceived.addListener(details => {
  const context = requests.get(details.requestId);
  if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300) return;
  if (!isPlaylistUrl(details.url)) return;
  capture(details, context).catch(console.error);
}, { urls: ['http://*/*', 'https://*/*'] });

const forget = details => requests.delete(details.requestId);
chrome.webRequest.onCompleted.addListener(forget, { urls: ['http://*/*', 'https://*/*'] });
chrome.webRequest.onErrorOccurred.addListener(forget, { urls: ['http://*/*', 'https://*/*'] });

async function capture(details, request) {
  await ready;
  const tab = await chrome.tabs.get(details.tabId);
  if (!tab.url?.startsWith('http')) return;
  const snapshot = await request?.pageSnapshot;
  if (snapshot?.url && snapshot.url !== tab.url) return;
  if (settings.serverUrl && tab.url.startsWith(serverBase(settings.serverUrl).href)) return;
  // 请求来自旧页面时不把它归到刚打开的新视频。同源 SPA 以捕获时的顶层 URL 为准。
  if (request?.documentUrl) {
    try {
      const source = new URL(request.documentUrl);
      const current = new URL(tab.url);
      if (source.origin === current.origin && source.pathname !== current.pathname) return;
    } catch { /* cross-origin player is associated with its tab */ }
  }
  const item = {
    id: crypto.randomUUID(), url: details.url, pageUrl: tab.url,
    title: tab.title || '', name: inferName(tab.url, tab.title),
    headers: downloadHeaders(tab.url),
    capturedAt: Date.now(),
  };
  await serial(keyFor(tab.id), async () => {
    const list = await getCaptures(tab.id);
    const existing = list.find(x => x.url === item.url && x.pageUrl === item.pageUrl);
    if (existing) {
      // 保留完整 URL，刷新页面信息，但不重复提示。
      Object.assign(existing, { headers: item.headers, capturedAt: item.capturedAt });
      await chrome.storage.session.set({ [keyFor(tab.id)]: list });
      return;
    }
    list.unshift(item);
    await chrome.storage.session.set({ [keyFor(tab.id)]: list.slice(0, 50) });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#2563eb' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: String(Math.min(list.length, 50)) });
    if (settings.showPrompt) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-prompt.js'] });
        await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_NOTICE', name: item.name });
      } catch { /* 工具栏弹窗仍然可以使用 */ }
    }
  });
}

chrome.tabs.onRemoved.addListener(id => {
  serial(keyFor(id), () => chrome.storage.session.remove([keyFor(id), pendingFor(id)])).catch(console.error);
});

chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === 'complete') injectHandoff(id).catch(console.error);
  if (change.status === 'loading' && change.url) {
    // 页面导航后清理上一个视频的列表；新页面请求按顺序写入。
    serial(keyFor(id), async () => {
      const list = (await getCaptures(id)).filter(x => x.pageUrl === change.url);
      await chrome.storage.session.set({ [keyFor(id)]: list });
      await chrome.action.setBadgeText({ tabId: id, text: list.length ? String(list.length) : '' });
    }).catch(console.error);
  }
});

async function injectHandoff(tabId) {
  const data = (await chrome.storage.session.get(pendingFor(tabId)))[pendingFor(tabId)];
  if (!data) return;
  if (Date.now() - data.createdAt > 10 * 60 * 1000) {
    await chrome.storage.session.remove(pendingFor(tabId));
    return;
  }
  const tab = await chrome.tabs.get(tabId);
  const actual = httpUrl(tab.url);
  const expected = httpUrl(data.url);
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname ||
      actual.searchParams.get('helper') !== data.nonce) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['download-bridge.js'] });
}

async function handleMessage(message, sender) {
  await ready;
  const internal = !sender.tab && sender.url?.startsWith(chrome.runtime.getURL(''));
  if (message.type === 'OPEN_POPUP') {
    if (!sender.tab) throw new Error('无效来源。');
    await chrome.action.openPopup();
    return {};
  }
  if (message.type === 'GET_HANDOFF' || message.type === 'HANDOFF_DONE') {
    if (!sender.tab || sender.frameId !== 0) throw new Error('无效来源。');
    const key = pendingFor(sender.tab.id);
    const pending = (await chrome.storage.session.get(key))[key];
    if (!pending || sender.url !== pending.url) throw new Error('下载页面与确认记录不匹配。');
    if (Date.now() - pending.createdAt > 10 * 60 * 1000) throw new Error('确认记录已过期，请重新发送。');
    if (message.type === 'HANDOFF_DONE') { await chrome.storage.session.remove(key); return {}; }
    return pending;
  }
  if (!internal) throw new Error('此操作只能从插件弹窗执行。');
  if (message.type === 'GET_STATE') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    return { settings, tab: { id: tab?.id, url: tab?.url || '' }, items: tab ? await getCaptures(tab.id) : [] };
  }
  if (message.type === 'SAVE_SETTINGS') {
    const next = { ...DEFAULT_SETTINGS, ...message.settings };
    if (next.serverUrl) next.serverUrl = serverBase(next.serverUrl).href;
    buildTask({ url: 'https://example.com/playlist.m3u8', name: 'check', pageUrl: 'https://example.com', headers: {} }, next);
    await chrome.storage.local.set({ settings: next });
    settings = next;
    return {};
  }
  if (message.type === 'CLEAR') {
    await serial(keyFor(message.tabId), () => chrome.storage.session.remove(keyFor(message.tabId)));
    await chrome.action.setBadgeText({ tabId: message.tabId, text: '' });
    return {};
  }
  if (message.type === 'SEND') {
    if (!settings.serverUrl) throw new Error('请先设置你的下载网站地址。');
    const item = (await getCaptures(message.tabId)).find(x => x.id === message.resourceId);
    if (!item) throw new Error('资源已清除，请重新播放并捕获。');
    const task = buildTask(item, settings, message.name);
    const nonce = crypto.randomUUID();
    const target = buildHandoffUrl({ ...item, name: task.filename, headers: task.headers }, settings, nonce);
    const tab = await chrome.tabs.create({ url: target, active: true });
    await chrome.storage.session.set({
      [pendingFor(tab.id)]: {
        nonce, url: target, task, autoStart: settings.autoStart, createdAt: Date.now(),
      },
    });
    // 覆盖快速加载页面可能早于 session 写入完成的情况。
    if ((await chrome.tabs.get(tab.id)).status === 'complete') await injectHandoff(tab.id);
    return { tabId: tab.id };
  }
  throw new Error('未知操作。');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handleMessage(message, sender).then(data => respond({ ok: true, data }), error => {
    respond({ ok: false, error: error.message || String(error) });
  });
  return true;
});
