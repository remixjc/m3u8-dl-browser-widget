export const DEFAULT_SETTINGS = {
  serverUrl: '',
  rootDir: '/app/downloads',
  perVideoFolder: true,
  autoStart: false,
  showPrompt: true,
};

export const DOWNLOAD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
export const HLS_NAME_MAX_LENGTH = 20;

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

export function manifestFilename(value) {
  try {
    const filename = httpUrl(value).pathname.split('/').pop();
    return ['playlist.m3u8', 'hls.m3u8'].includes(filename) ? filename : '';
  } catch { return ''; }
}

export function inferCaptureName(mediaUrl, pageUrl, title = '') {
  // hls 站点按页面标题命名，不从地址或标题提取视频编号。
  if (manifestFilename(mediaUrl) === 'hls.m3u8') return sanitizeResourceName(mediaUrl, title);
  return inferName(pageUrl, title);
}

export function sanitizeResourceName(mediaUrl, value) {
  const name = safeName(value);
  // 按 Unicode 字符截取，避免把 emoji 的代理对切成半个字符。
  return manifestFilename(mediaUrl) === 'hls.m3u8'
    ? safeName(Array.from(name).slice(0, HLS_NAME_MAX_LENGTH).join(''))
    : name;
}

export function downloadHeaders(pageUrl) {
  return { Referer: httpUrl(pageUrl).href, 'User-Agent': DOWNLOAD_USER_AGENT };
}

export function buildTask(resource, settings, nameOverride) {
  if (!manifestFilename(resource.url)) throw new Error('只支持文件名为 playlist.m3u8 或 hls.m3u8 的下载地址。');
  const filename = sanitizeResourceName(resource.url, nameOverride || resource.name);
  const inputRoot = String(settings.rootDir || '').trim();
  const root = inputRoot === '/' || /^[a-z]:[\\/]$/i.test(inputRoot) ? inputRoot : inputRoot.replace(/[\\/]+$/, '');
  if (!root || /[\r\n\u0000]/.test(root) || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(root)) {
    throw new Error('请设置 Docker 内的绝对下载根目录，例如 /app/downloads。');
  }
  if (root.split(/[\\/]/).includes('..')) throw new Error('下载根目录不能包含 ..。');
  const headers = downloadHeaders(resource.pageUrl);
  const separator = /^[a-z]:\\/i.test(root) || root.startsWith('\\\\') ? '\\' : '/';
  const saveRoot = manifestFilename(resource.url) === 'hls.m3u8'
    ? `${root.replace(/[\\/]+$/, '')}${separator}hls`
    : root;
  return {
    url: resource.url,
    filename,
    saveDir: settings.perVideoFolder ? `${saveRoot.replace(/[\\/]+$/, '')}${separator}${filename}` : saveRoot,
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
  url.searchParams.set('title', sanitizeResourceName(resource.url, resource.name));
  url.searchParams.set('helper', nonce);
  // 凭据不进入服务器收到的 URL query。保存目录由注入的表单桥接器填入。
  url.hash = new URLSearchParams({ headers: JSON.stringify(downloadHeaders(resource.pageUrl)) }).toString();
  return url.href;
}
