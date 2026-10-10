export const DEFAULT_SETTINGS = {
  serverUrl: '',
  rootDir: '/app/downloads',
  perVideoFolder: true,
  autoStart: false,
  showPrompt: true,
};

export const DOWNLOAD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请输入不含账号密码的 http 或 https 地址。');
  }
  return url;
}

export function serverBase(value) {
  const url = httpUrl(value.trim());
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/page\/.*$/, '').replace(/\/+$/, '') + '/';
  return url;
}

export function safeName(value) {
  const name = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*$\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') return '未命名视频';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

export function inferName(pageUrl, title = '') {
  let path = '';
  try { path = decodeURIComponent(new URL(pageUrl).pathname); } catch { /* use title */ }
  const code = /(?:^|[^a-z0-9])([a-z]{2,12})[-_](\d{2,8})(?=$|[^a-z0-9])/i;
  for (const source of [path, title]) {
    const match = source.match(code);
    if (match) return `${match[1].toUpperCase()}-${match[2]}`;
  }
  return safeName(title || path.split('/').filter(Boolean).pop() || '未命名视频');
}

export function isPlaylistUrl(value) {
  try { return httpUrl(value).pathname.endsWith('/playlist.m3u8'); } catch { return false; }
}

export function downloadHeaders(pageUrl) {
  return { Referer: httpUrl(pageUrl).href, 'User-Agent': DOWNLOAD_USER_AGENT };
}

export function buildTask(resource, settings, nameOverride) {
  if (!isPlaylistUrl(resource.url)) throw new Error('只支持文件名为 playlist.m3u8 的下载地址。');
  const filename = safeName(nameOverride || resource.name);
  const inputRoot = String(settings.rootDir || '').trim();
  const root = inputRoot === '/' || /^[a-z]:[\\/]$/i.test(inputRoot) ? inputRoot : inputRoot.replace(/[\\/]+$/, '');
  if (!root || /[\r\n\u0000]/.test(root) || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(root)) {
    throw new Error('请设置 Docker 内的绝对下载根目录，例如 /app/downloads。');
  }
  if (root.split(/[\\/]/).includes('..')) throw new Error('下载根目录不能包含 ..。');
  const headers = downloadHeaders(resource.pageUrl);
  const separator = /^[a-z]:\\/i.test(root) || root.startsWith('\\\\') ? '\\' : '/';
  return {
    url: resource.url,
    filename,
    saveDir: settings.perVideoFolder ? `${root.replace(/[\\/]+$/, '')}${separator}${filename}` : root,
    headers,
  };
}

export function buildHandoffUrl(resource, settings, nonce) {
  const url = new URL('page/download', serverBase(settings.serverUrl));
  url.searchParams.set('from', 'chrome-helper');
  url.searchParams.set('action', 'new');
  // 当前 WebUI 的路由先解码一次，App.vue 又 decodeURIComponent 一次。
  // 双重编码确保签名 URL 内的 %2F、%25、中文等原样恢复。
  url.searchParams.set('url', encodeURIComponent(resource.url));
  url.searchParams.set('title', resource.name);
  url.searchParams.set('helper', nonce);
  // 凭据不进入服务器收到的 URL query。保存目录由注入的表单桥接器填入。
  url.hash = new URLSearchParams({ headers: JSON.stringify(downloadHeaders(resource.pageUrl)) }).toString();
  return url.href;
}
