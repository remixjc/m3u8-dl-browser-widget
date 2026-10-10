import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, buildHandoffUrl, buildTask, httpUrl, inferName,
  DOWNLOAD_USER_AGENT, downloadHeaders, isPlaylistUrl, manifestFilename, inferCaptureName,
  sanitizeResourceName, safeName, serverBase,
} from '../core.js';

const settings = { ...DEFAULT_SETTINGS, serverUrl: 'http://localhost:6600' };
const resource = {
  url: 'https://cdn.example/video/playlist.m3u8',
  pageUrl: 'https://site.example/en/sw-359-uncensored-leak',
  name: 'SW-359', userAgent: 'Test UA',
  headers: { referer: 'https://player.example/', cookie: 'secret=1', authorization: 'Bearer secret' },
};

test('从播放页提取编号，不受 CDN UUID 影响', () => {
  assert.equal(inferName(resource.pageUrl, 'Other title'), 'SW-359');
  assert.equal(inferName('https://site.example/watch/99', 'ABC_123 · 视频'), 'ABC-123');
  assert.equal(inferName('https://site.example/watch/99', '普通视频'), '普通视频');
});
test('严格匹配 playlist.m3u8 文件名，查询参数不影响捕获', () => {
  assert.ok(isPlaylistUrl('https://cdn.example/playlist.m3u8'));
  assert.ok(isPlaylistUrl('https://cdn.example/id/playlist.m3u8?token=1'));
  for (const url of [
    'https://cdn.example/master.m3u8', 'https://cdn.example/index.m3u8',
    'https://cdn.example/notplaylist.m3u8', 'https://cdn.example/playlist.m3u8.bak',
    'https://cdn.example/playlist.m3u8/segment.ts', 'https://cdn.example/api?url=playlist.m3u8',
    'https://cdn.example/PLAYLIST.M3U8', 'javascript:alert(1)',
  ]) assert.equal(isPlaylistUrl(url), false, url);
});
test('请求头仅包含指定大小写的两行，使用地址栏网址和固定 UA', () => {
  const task = buildTask(resource, settings);
  assert.equal(task.filename, 'SW-359');
  assert.equal(task.saveDir, '/app/downloads/SW-359');
  assert.deepEqual(task.headers, {
    Referer: resource.pageUrl,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
});
test('hls.m3u8 严格匹配文件名，标题命名不提取编号，保留签名并生成安全目录', () => {
  const url = 'https://cdn.example/video/hls.m3u8?sig=%25%2F&name=playlist.m3u8';
  assert.equal(manifestFilename(url), 'hls.m3u8');
  assert.equal(manifestFilename(resource.url), 'playlist.m3u8');
  for (const value of [
    'https://cdn.example/nothls.m3u8', 'https://cdn.example/hls.m3u8.bak',
    'https://cdn.example/hls.m3u8/segment.ts', 'https://cdn.example/api?file=hls.m3u8',
    'https://cdn.example/HLS.M3U8', 'https://cdn.example/index.m3u8', 'javascript:alert(1)',
  ]) assert.equal(manifestFilename(value), '', value);
  const title = 'SW-359 完整文章标题 / 第一章：高清版';
  const name = inferCaptureName(url, resource.pageUrl, title);
  assert.equal(name, 'SW-359 完整文章标题 _ 第一章_');
  assert.equal(inferCaptureName(resource.url, resource.pageUrl, title), 'SW-359');
  assert.equal(inferCaptureName(url, resource.pageUrl, ''), '未命名视频');
  assert.equal(inferCaptureName(url, resource.pageUrl, 'CON'), '_CON');
  const hls = { ...resource, url, name, title };
  const task = buildTask(hls, settings);
  assert.equal(task.url, url);
  assert.equal(task.filename, name);
  assert.equal(task.saveDir, `/app/downloads/hls/${name}`);
  assert.deepEqual(task.headers, downloadHeaders(resource.pageUrl));
  const target = new URL(buildHandoffUrl(hls, settings, 'hls-nonce'));
  assert.equal(decodeURIComponent(target.searchParams.get('url')), url);
  assert.equal(target.searchParams.get('title'), name);
  assert.equal(buildTask(hls, settings, '手动名称').filename, '手动名称');
});
test('hls 名称最多 20 字符，缓存或手动长名称不能绕过限制，文件名与目录保持一致', () => {
  const url = 'https://cdn.example/hls.m3u8?token=1';
  for (const length of [19, 20, 21]) {
    assert.equal(sanitizeResourceName(url, '中'.repeat(length)), '中'.repeat(Math.min(length, 20)));
  }
  const title = '😀'.repeat(21);
  const shortName = '😀'.repeat(20);
  assert.equal(inferCaptureName(url, resource.pageUrl, title), shortName);
  assert.equal(sanitizeResourceName(url, `${'中'.repeat(19)}.`), '中'.repeat(19));
  assert.equal(sanitizeResourceName(url, 'NUL'), '_NUL');
  assert.equal(sanitizeResourceName(url, ''), '未命名视频');
  const hls = { ...resource, url, name: title };
  for (const override of [undefined, `${shortName}需要删除的后缀`]) {
    const task = buildTask(hls, settings, override);
    assert.equal(task.filename, shortName);
    assert.equal(task.saveDir, `/app/downloads/hls/${shortName}`);
  }
  assert.equal(new URL(buildHandoffUrl(hls, settings, 'short')).searchParams.get('title'), shortName);
  assert.equal(buildTask({ ...resource, name: '中'.repeat(30) }, settings).filename, '中'.repeat(30));
});
test('hls 在根目录下隔离保存，支持关闭标题子目录和 Linux、Windows、UNC 根路径', () => {
  const hls = { ...resource, url: 'https://cdn.example/hls.m3u8', name: '文章标题' };
  for (const [rootDir, expected] of [
    ['/app/downloads/', '/app/downloads/hls'],
    ['/', '/hls'],
    ['D:\\downloads\\', 'D:\\downloads\\hls'],
    ['C:\\', 'C:\\hls'],
    ['D:/downloads/', 'D:/downloads/hls'],
    ['\\\\server\\share\\', '\\\\server\\share\\hls'],
  ]) {
    const separator = expected.includes('\\') ? '\\' : '/';
    assert.equal(buildTask(hls, { ...settings, rootDir, perVideoFolder: false }).saveDir, expected);
    assert.equal(buildTask(hls, { ...settings, rootDir }).saveDir, `${expected}${separator}文章标题`);
  }
  assert.equal(buildTask(resource, settings).saveDir, '/app/downloads/SW-359');
  assert.equal(buildTask(resource, { ...settings, perVideoFolder: false }).saveDir, '/app/downloads');
});
test('旧版请求头设置不能覆盖固定格式或传入 Cookie/Origin', () => {
  const task = buildTask(resource, { ...settings, includeSensitive: true, refererMode: 'request' });
  assert.deepEqual(task.headers, downloadHeaders(resource.pageUrl));
  assert.equal(Object.keys(task.headers).length, 2);
  assert.equal(task.headers['User-Agent'], DOWNLOAD_USER_AGENT);
  assert.throws(() => buildTask({ ...resource, url: 'https://cdn.example/master.m3u8' }, settings), /只支持/);
});
test('Referer 保留地址栏路径、查询参数与 fragment，不使用播放器地址', () => {
  const pageUrl = 'https://site.example/en/sw-359?ref=abc%2Fdef#player';
  assert.deepEqual(downloadHeaders(pageUrl), { Referer: pageUrl, 'User-Agent': DOWNLOAD_USER_AGENT });
});
test('路径清理阻止文件名越界，支持 Linux 与 Windows 根目录', () => {
  assert.equal(buildTask(resource, settings, '../../bad\\name').saveDir, '/app/downloads/.._.._bad_name');
  assert.equal(buildTask(resource, { ...settings, rootDir: '/' }).saveDir, '/SW-359');
  assert.equal(buildTask(resource, { ...settings, rootDir: 'D:\\downloads\\' }).saveDir, 'D:\\downloads\\SW-359');
  assert.equal(buildTask(resource, { ...settings, rootDir: 'C:\\' }).saveDir, 'C:\\SW-359');
  assert.equal(buildTask(resource, { ...settings, perVideoFolder: false }).saveDir, '/app/downloads');
  assert.throws(() => buildTask(resource, { ...settings, rootDir: '/app/../etc' }), /不能包含/);
  assert.throws(() => buildTask(resource, { ...settings, rootDir: 'relative/path' }), /绝对/);
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('..'), '未命名视频');
});
test('下载网站地址支持根路径、已打开的下载页和子路径部署', () => {
  assert.equal(serverBase('http://localhost:6600/page/download?x=1#token').href, 'http://localhost:6600/');
  assert.equal(serverBase('https://example.com/downloader/').href, 'https://example.com/downloader/');
  assert.throws(() => httpUrl('javascript:alert(1)'));
  assert.throws(() => httpUrl('https://user:pass@example.com'));
});
test('按当前 WebUI 双重解码流程完整还原签名 URL', () => {
  const signed = 'https://cdn.example/a%2Fb/playlist.m3u8?sig=%25%2F%3D&label=%E4%B8%AD%E6%96%87&empty=&plus=+&raw=%ZZ';
  const target = new URL(buildHandoffUrl({ ...resource, url: signed }, settings, 'nonce'));
  assert.equal(decodeURIComponent(target.searchParams.get('url')), signed);
  assert.equal(target.pathname, '/page/download');
  assert.equal(target.searchParams.get('title'), 'SW-359');
  assert.equal(target.searchParams.get('autoStart'), null);
  const headers = JSON.parse(new URLSearchParams(target.hash.slice(1)).get('headers'));
  assert.deepEqual(headers, downloadHeaders(resource.pageUrl));
  assert.equal(target.searchParams.get('headers'), null);
});
test('子路径 handoff 正确指向下载页', () => {
  const target = new URL(buildHandoffUrl(resource, { ...settings, serverUrl: 'https://host.example/tools/' }, 'n'));
  assert.equal(target.pathname, '/tools/page/download');
});
