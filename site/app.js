const menu = document.querySelector('.menu-toggle');
const nav = document.querySelector('#navigation');
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? '收起导航' : '展开导航');
  nav.classList.toggle('is-open', open);
});
nav.addEventListener('click', event => {
  if (event.target.closest('a')) {
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', '展开导航');
    nav.classList.remove('is-open');
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    menu.click();
    menu.focus();
  }
});

const discover = document.querySelector('#discover');
const send = document.querySelector('#send-demo');
discover.addEventListener('click', () => {
  document.querySelector('.hero-art').classList.add('is-discovered');
  document.querySelector('#capture-title').textContent = '发现 1 个视频资源';
  document.querySelector('#capture-status').textContent = '已捕获';
  document.querySelector('#player-caption').textContent = 'playlist.m3u8 已被发现';
  document.querySelector('#play-time').textContent = '00:12';
  document.querySelector('#play-progress').style.width = '24%';
  document.querySelector('#server-state').textContent = 'm3u8-dl · 等待接收';
  document.querySelector('#server-indicator').classList.remove('connected');
  document.querySelector('#demo-note').textContent = '名称与目录已整理 · 点击下方继续演示';
  send.disabled = false;
  send.innerHTML = '确认发送 <span aria-hidden="true">↗</span>';
  discover.setAttribute('aria-label', '重新模拟发现资源');
});
send.addEventListener('click', () => {
  document.querySelector('#server-state').textContent = 'm3u8-dl · 参数已就绪';
  document.querySelector('#server-indicator').classList.add('connected');
  document.querySelector('#demo-note').textContent = '演示完成 · 实际使用时将打开你的下载表单';
  send.innerHTML = '演示完成 <span aria-hidden="true">✓</span>';
  send.disabled = true;
});

document.querySelector('#copy-address').addEventListener('click', async () => {
  const feedback = document.querySelector('#copy-feedback');
  try {
    await navigator.clipboard.writeText('chrome://extensions');
    document.querySelector('#copy-label').textContent = '已复制 ✓';
    feedback.textContent = '已复制，在 Chrome 地址栏粘贴打开。';
  } catch {
    feedback.textContent = '请手动复制 chrome://extensions，在 Chrome 地址栏打开。';
  }
});
