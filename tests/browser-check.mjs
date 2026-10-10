// 仅访问本机测试服务器；不访问实际视频网站，不提交真实下载。
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { buildTask, DEFAULT_SETTINGS } from '../core.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.test-output');
await mkdir(output, { recursive: true });
const task = buildTask({
  url: 'https://cdn.example/a%2Fb/playlist.m3u8?token=%25%2F&part=1',
  name: 'SW-359', pageUrl: 'https://site.example/en/sw-359',
  headers: { referer: 'https://wrong.example/', 'user-agent': 'Wrong UA', origin: 'https://wrong.example/' },
}, DEFAULT_SETTINGS);
function fixture(mode) {
  return `<!doctype html><html><meta charset="UTF-8"><body>
  <div class="modal-overlay">
    <textarea id="urls"></textarea>
    <input id="name" class="focus:ring-green-500">
    <input id="directory" class="${mode === 'changed' ? 'unknown' : 'focus:ring-yellow-500'}">
    <div class="collapse-wrapper"><button id="basic">基本设置</button><div id="basic-content"></div></div>
    <button id="submit">开始下载</button>
  </div>
  ${mode === 'password' ? '<input type="password" id="password">' : ''}
  <script>
    window.task = ${JSON.stringify(task)};
    window.events = { clicks: 0, consumed: 0, inputs: {} };
    document.getElementById('urls').value = task.url;
    document.getElementById('submit').onclick = () => events.clicks++;
    document.getElementById('basic').onclick = () => {
      if (!document.getElementById('headers')) {
        const h = document.createElement('textarea');
        h.id = 'headers'; h.className = 'focus:ring-gray-500';
        document.getElementById('basic-content').append(h);
      }
    };
    document.addEventListener('input', e => { events.inputs[e.target.id] = e.target.value; });
    window.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: {saveDir: '/app/downloads'} }) });
    window.chrome = { runtime: { sendMessage: async message => {
      if (message.type === 'HANDOFF_DONE') { events.consumed++; return {ok: true}; }
      return {ok: true, data: {task, autoStart: ${mode !== 'review'}}};
    }}};
  </script>
  <script src="/download-bridge.js"></script></body></html>`;
}
const state = {
  settings: {
    serverUrl: 'http://your-server:6600/', rootDir: '/app/downloads', perVideoFolder: true,
    autoStart: false, showPrompt: true,
  },
  tab: { id: 7, url: 'https://site.example/sw-359' },
  items: [{ id: 'r', name: 'SW-359', url: task.url, headers: task.headers, pageUrl: task.headers.Referer }],
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    let text;
    if (url.pathname === '/page/download') text = fixture(url.searchParams.get('mode'));
    else if (url.pathname === '/popup.html') {
      text = await readFile(path.join(root, 'popup.html'), 'utf8');
      const stub = `<script>window.chrome = {
        runtime: {sendMessage: async () => ({ok:true, data:${JSON.stringify(state)}})},
        storage: {onChanged: {addListener() {}}}
      };</script>`;
      text = text.replace('<script type="module"', `${stub}<script type="module"`);
    } else {
      const file = url.pathname.slice(1);
      if (!['core.js', 'popup.js', 'popup.css', 'download-bridge.js'].includes(file)) {
        res.writeHead(404); res.end(); return;
      }
      text = await readFile(path.join(root, file), 'utf8');
    }
    res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' :
      url.pathname.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(text);
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const executable = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = spawn(executable, [
  '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${path.join(output, `profile-${Date.now()}`)}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--window-size=460,800', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
let ws;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error(`Chrome startup timeout: ${log.slice(-1000)}`)), 15000);
    browser.once('error', error => { clearTimeout(timeout); reject(error); });
    browser.stderr.on('data', chunk => {
      log += chunk.toString();
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const runtimeErrors = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  };
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, {
      resolve: result => { clearTimeout(timer); resolve(result); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Runtime.enable', {}, sessionId);
  const evalInPage = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let i = 0; i < 70; i++) {
      if (await evalInPage(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Page condition timeout: ${expression}\n${await evalInPage('JSON.stringify({text:document.body.innerText, url:location.href, bridge:window.__m3u8HelperBridgeInstalled, state:document.readyState})')}\n${JSON.stringify(runtimeErrors)}`);
  };
  for (const mode of ['review', 'auto', 'password', 'changed']) {
    await call('Page.navigate', { url: `${base}/page/download?mode=${mode}#headers=test` }, sessionId);
    await waitFor(`location.search === "?mode=${mode}" && document.readyState === "complete" && typeof window.events === "object"`);
    if (mode === 'password') {
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(await evalInPage('events.clicks'), 0, 'password must block automatic submit');
      await evalInPage('document.getElementById("password").remove()');
    }
    if (mode === 'changed') {
      await waitFor('document.body.textContent.includes("表单结构与适配版本不同")');
      assert.equal(await evalInPage('events.clicks'), 0);
    } else {
      await waitFor('events.consumed === 1');
      const result = await evalInPage('({ ...events, hash: location.hash })');
      assert.equal(result.inputs.urls, task.url);
      assert.equal(result.inputs.name, task.filename);
      assert.equal(result.inputs.directory, task.saveDir);
      assert.equal(result.inputs.headers, 'Referer: https://site.example/en/sw-359\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      assert.equal(result.clicks, mode === 'review' ? 0 : 1);
      assert.equal(result.hash, '');
    }
    console.log(`PASS browser bridge: ${mode}`);
  }
  await call('Page.navigate', { url: `${base}/popup.html` }, sessionId);
  await waitFor('document.querySelectorAll(".card").length === 1');
  assert.equal(await evalInPage('document.querySelector(".path").textContent'), '保存至：/app/downloads/SW-359');
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  await writeFile(path.join(output, 'popup.png'), Buffer.from(shot.data, 'base64'));
  console.log(`PASS popup render: ${path.join(output, 'popup.png')}`);
  await call('Browser.close').catch(() => {});
} finally {
  ws?.close();
  browser.kill();
  server.close();
}
