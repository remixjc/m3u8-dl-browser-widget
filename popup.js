import { buildTask, manifestFilename, serverBase } from './core.js';
const $ = id => document.getElementById(id);
let state;
const report = (message, error = false) => {
  $('status').textContent = message;
  $('status').className = error ? 'error' : '';
};
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || '插件后台未响应，请刷新插件。');
  return reply.data;
}
function fillSettings(settings) {
  $('server-url').value = settings.serverUrl;
  $('root-dir').value = settings.rootDir;
  for (const [id, key] of [
    ['per-video-folder', 'perVideoFolder'], ['auto-start', 'autoStart'],
    ['show-prompt', 'showPrompt'],
  ]) $(id).checked = settings[key];
}
function readSettings() {
  return {
    serverUrl: $('server-url').value.trim(), rootDir: $('root-dir').value.trim(),
    perVideoFolder: $('per-video-folder').checked, autoStart: $('auto-start').checked,
    showPrompt: $('show-prompt').checked,
  };
}
function renderItems() {
  $('count').textContent = `当前页面 · ${state.items.length} 个视频资源`;
  $('items').replaceChildren();
  if (!state.items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '打开视频播放页并点击播放。\n支持 playlist.m3u8 和 hls.m3u8 请求。\n安装或授权后需要刷新原网页。';
    empty.style.whiteSpace = 'pre-line';
    $('items').append(empty);
    return;
  }
  for (const resource of state.items) {
    const card = document.createElement('article');
    card.className = 'card';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = manifestFilename(resource.url);
    const label = document.createElement('label');
    label.textContent = '视频名称 / 子文件夹名称';
    const name = document.createElement('input');
    name.value = resource.name;
    name.maxLength = 100;
    label.append(name);
    const url = document.createElement('div');
    url.className = 'resource';
    url.textContent = resource.url;
    const path = document.createElement('div');
    path.className = 'path';
    const preview = () => {
      try { path.textContent = `保存至：${buildTask(resource, state.settings, name.value).saveDir}`; }
      catch (error) { path.textContent = error.message; }
    };
    name.addEventListener('input', preview);
    preview();
    const confirm = document.createElement('button');
    confirm.className = 'primary';
    confirm.textContent = state.settings.autoStart ? '确认下载 → 打开网站并开始' : '确认发送 → 打开并填入下载页';
    confirm.onclick = async () => {
      confirm.disabled = true;
      try {
        if (!state.settings.serverUrl) {
          $('settings').open = true;
          throw new Error('先在下方配置下载网站地址并保存。');
        }
        const base = serverBase(state.settings.serverUrl);
        const pattern = `${base.protocol}//${base.hostname}/*`;
        if (!await chrome.permissions.contains({ origins: [pattern] })) {
          $('settings').open = true;
          throw new Error('下载网站权限已失效，请在下方重新保存设置并授权。');
        }
        await send({ type: 'SEND', tabId: state.tab.id, resourceId: resource.id, name: name.value });
        window.close();
      } catch (error) { report(error.message, true); confirm.disabled = false; }
    };
    card.append(tag, label, url, path, confirm);
    $('items').append(card);
  }
}
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const next = readSettings();
    const base = serverBase(next.serverUrl);
    const pattern = `${base.protocol}//${base.hostname}/*`;
    if (!await chrome.permissions.request({ origins: [pattern] })) throw new Error('下载网站授权未获允许。');
    await send({ type: 'SAVE_SETTINGS', settings: next });
    state.settings = next;
    renderItems();
    report('设置已保存。请回到视频页播放视频；确认发送后会自动填入名称、路径和请求头。');
  } catch (error) { report(error.message, true); }
});
$('clear').onclick = async () => {
  try {
    await send({ type: 'CLEAR', tabId: state.tab.id });
    state.items = [];
    renderItems();
  } catch (error) { report(error.message, true); }
};
$('grant-all').onclick = async () => {
  try {
    const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
    report(granted ? '已开启其他网站捕获。请刷新视频页并重新播放。' : '未授权，仍只捕获默认支持的域名。');
  } catch (error) { report(error.message, true); }
};
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'session' || !state || !changes[`captures:${state.tab.id}`]) return;
  state.items = changes[`captures:${state.tab.id}`].newValue || [];
  renderItems();
});
send({ type: 'GET_STATE' }).then(data => {
  state = data;
  fillSettings(data.settings);
  $('settings').open = !data.settings.serverUrl;
  renderItems();
}).catch(error => report(error.message, true));
