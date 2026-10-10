import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, downloadHeaders } from '../core.js';

function event() {
  const handlers = [];
  return { handlers, addListener: fn => handlers.push(fn) };
}
const store = {};
const tabs = new Map([[7, {
  id: 7, url: 'https://missav.live/en/sw-359-uncensored-leak', title: 'SW-359 title', status: 'complete',
}]]);
let tabCounter = 20;
const messages = [];
const injections = [];
const settings = { ...DEFAULT_SETTINGS, serverUrl: 'http://localhost:6600', showPrompt: false };
globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({ settings }),
      set: async data => { Object.assign(settings, data.settings); },
    },
    session: {
      get: async key => ({ [key]: structuredClone(store[key]) }),
      set: async data => { Object.assign(store, structuredClone(data)); },
      remove: async keys => { for (const key of [].concat(keys)) delete store[key]; },
    },
    onChanged: event(),
  },
  webRequest: {
    onBeforeSendHeaders: event(), onHeadersReceived: event(), onCompleted: event(), onErrorOccurred: event(),
  },
  tabs: {
    get: async id => structuredClone(tabs.get(id)),
    query: async () => [tabs.get(7)],
    create: async options => {
      const tab = { id: ++tabCounter, ...options, status: 'complete' };
      tabs.set(tab.id, tab);
      return tab;
    },
    sendMessage: async (id, message) => messages.push({ id, message }),
    onRemoved: event(), onUpdated: event(),
  },
  action: {
    setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, openPopup: async () => {},
  },
  scripting: { executeScript: async script => injections.push(script) },
  runtime: { getURL: path => `chrome-extension://test/${path}`, onMessage: event() },
};
await import('../background.js');
const flush = () => new Promise(resolve => setTimeout(resolve, 30));
const internal = { url: 'chrome-extension://test/popup.html' };
const message = (data, sender = internal) => new Promise(resolve => {
  chrome.runtime.onMessage.handlers[0](data, sender, resolve);
});
const mediaUrl = 'https://surrit.com/id/playlist.m3u8?sig=abc%2F123';
function request(id, url = mediaUrl, contentType = 'application/vnd.apple.mpegurl') {
  chrome.webRequest.onBeforeSendHeaders.handlers[0]({
    requestId: id, tabId: 7, url, documentUrl: tabs.get(7).url,
    requestHeaders: [{ name: 'User-Agent', value: 'Actual Chrome UA' }, { name: 'Cookie', value: 'secret=x' }],
  });
  chrome.webRequest.onHeadersReceived.handlers[0]({
    requestId: id, tabId: 7, url, statusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: contentType }],
  });
}

test('后台捕获、去重、确认发送与来源限制', async t => {
  await t.test('同一资源的并发事件不会重复插入，不删除签名参数', async () => {
    request('1'); request('2');
    await flush();
    const { data } = await message({ type: 'GET_STATE' });
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].url, mediaUrl);
    assert.equal(data.items[0].name, 'SW-359');
    assert.deepEqual(data.items[0].headers, downloadHeaders(tabs.get(7).url));
  });
  await t.test('其他 m3u8 和无后缀接口即使是 HLS MIME 也不捕获', async () => {
    request('3', 'https://surrit.com/api/stream?token=2');
    request('4', 'https://surrit.com/id/master.m3u8');
    request('5', 'https://surrit.com/id/notplaylist.m3u8');
    request('6', 'https://surrit.com/id/playlist.m3u8.bak');
    request('7', 'https://surrit.com/api?file=playlist.m3u8');
    await flush();
    const { data } = await message({ type: 'GET_STATE' });
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].url, mediaUrl);
  });
  await t.test('网页 content script 不能伪造确认下载', async () => {
    const response = await message({ type: 'SEND', tabId: 7 }, {
      tab: { id: 7 }, url: tabs.get(7).url, frameId: 0,
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /只能从插件弹窗/);
  });
  let handoffId;
  await t.test('确认后创建独立下载标签，保存每条资源的目录和请求头', async () => {
    const state = (await message({ type: 'GET_STATE' })).data;
    const reply = await message({ type: 'SEND', tabId: 7, resourceId: state.items[0].id, name: 'SW-359' });
    assert.equal(reply.ok, true);
    handoffId = reply.data.tabId;
    const target = tabs.get(handoffId);
    assert.equal(new URL(target.url).pathname, '/page/download');
    assert.equal(store[`handoff:${handoffId}`].task.saveDir, '/app/downloads/SW-359');
    assert.deepEqual(store[`handoff:${handoffId}`].task.headers, downloadHeaders(tabs.get(7).url));
    const headerHash = new URLSearchParams(new URL(target.url).hash.slice(1)).get('headers');
    assert.deepEqual(JSON.parse(headerHash), downloadHeaders(tabs.get(7).url));
    assert.ok(injections.some(value => value.target.tabId === handoffId));
  });
  await t.test('其他标签和子 frame 不能读取下载凭据', async () => {
    const sender = { tab: { id: handoffId }, url: tabs.get(handoffId).url, frameId: 0 };
    assert.equal((await message({ type: 'GET_HANDOFF' }, { ...sender, url: 'https://evil.example/' })).ok, false);
    assert.equal((await message({ type: 'GET_HANDOFF' }, { ...sender, frameId: 1 })).ok, false);
    assert.equal((await message({ type: 'GET_HANDOFF' }, sender)).ok, true);
    assert.equal((await message({ type: 'HANDOFF_DONE' }, sender)).ok, true);
    assert.equal((await message({ type: 'GET_HANDOFF' }, sender)).ok, false);
  });
  await t.test('从旧页面到达的晚请求不会套用新视频编号', async () => {
    const old = tabs.get(7).url;
    tabs.get(7).url = 'https://missav.live/en/abc-123';
    chrome.webRequest.onBeforeSendHeaders.handlers[0]({
      requestId: 'old', tabId: 7, url: 'https://surrit.com/old/playlist.m3u8',
      documentUrl: old, requestHeaders: [],
    });
    chrome.webRequest.onHeadersReceived.handlers[0]({
      requestId: 'old', tabId: 7, url: 'https://surrit.com/old/playlist.m3u8', statusCode: 200, responseHeaders: [],
    });
    await flush();
    assert.equal((await message({ type: 'GET_STATE' })).data.items.length, 1);
  });
  await t.test('跨域播放器晚响应也绑定发请求时的顶层页面', async () => {
    chrome.webRequest.onBeforeSendHeaders.handlers[0]({
      requestId: 'iframe', tabId: 7, url: 'https://surrit.com/iframe/playlist.m3u8',
      documentUrl: 'https://player.example/embedded', requestHeaders: [],
    });
    tabs.get(7).url = 'https://missav.live/en/xyz-456';
    chrome.webRequest.onHeadersReceived.handlers[0]({
      requestId: 'iframe', tabId: 7, url: 'https://surrit.com/iframe/playlist.m3u8',
      statusCode: 200, responseHeaders: [],
    });
    await flush();
    assert.equal((await message({ type: 'GET_STATE' })).data.items.length, 1);
  });
  await t.test('旧版缓存中的其他 HLS 地址不再显示或发送', async () => {
    store['captures:7'].push({ id: 'legacy', url: 'https://surrit.com/old/master.m3u8' });
    assert.equal((await message({ type: 'GET_STATE' })).data.items.length, 1);
    assert.equal((await message({ type: 'SEND', tabId: 7, resourceId: 'legacy' })).ok, false);
  });
  await t.test('hls 清单按完整标题捕获并发送，重复请求更新晚到的页面标题', async () => {
    const hlsUrl = 'https://cdn.example/article/hls.m3u8?sig=abc%2F%25';
    tabs.get(7).url = 'https://article.example/video/abc-123';
    tabs.get(7).title = '加载中';
    request('hls-loading', hlsUrl);
    await flush();
    tabs.get(7).title = 'ABC-123 完整文章标题 / 第二章';
    request('hls-ready', hlsUrl);
    await flush();
    const items = (await message({ type: 'GET_STATE' })).data.items;
    const hlsItems = items.filter(item => item.url === hlsUrl);
    assert.equal(hlsItems.length, 1);
    assert.equal(hlsItems[0].name, 'ABC-123 完整文章标题 _ 第二章');
    const reply = await message({ type: 'SEND', tabId: 7, resourceId: hlsItems[0].id });
    assert.equal(reply.ok, true);
    const task = store[`handoff:${reply.data.tabId}`].task;
    assert.equal(task.url, hlsUrl);
    assert.equal(task.filename, hlsItems[0].name);
    assert.equal(task.saveDir, '/app/downloads/ABC-123 完整文章标题 _ 第二章');
    assert.deepEqual(task.headers, downloadHeaders(tabs.get(7).url));
  });
});
