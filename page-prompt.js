(() => {
  if (globalThis.__m3u8HelperPromptInstalled) return;
  globalThis.__m3u8HelperPromptInstalled = true;
  let host;
  let dismissedPage = '';
  let lastName = '';
  chrome.runtime.onMessage.addListener(message => {
    if (message.type !== 'CAPTURE_NOTICE' || dismissedPage === location.href) return;
    if (host?.isConnected && lastName === message.name) return;
    host?.remove();
    lastName = message.name;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      *{box-sizing:border-box}section{width:300px;padding:18px;background:#fff;color:#172033;
      border:1px solid #dce4f1;border-radius:16px;box-shadow:0 12px 48px #11182740;
      font:14px/1.5 system-ui,sans-serif}strong{font-size:16px}p{margin:8px 0 14px;color:#64748b}
      button{border:0;border-radius:9px;padding:10px 14px;font:inherit;cursor:pointer}
      .primary{background:#2563eb;color:#fff}.close{float:right;background:#f1f5f9;padding:2px 9px}
    `;
    const panel = document.createElement('section');
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', '本页不再提示');
    close.onclick = event => { if (event.isTrusted) { dismissedPage = location.href; host.remove(); } };
    const title = document.createElement('strong');
    title.textContent = `发现视频 · ${message.name}`;
    const info = document.createElement('p');
    info.textContent = '已捕获 playlist.m3u8。查看名称和保存位置后，发送到你的下载网站。';
    const button = document.createElement('button');
    button.className = 'primary';
    button.textContent = '查看并确认';
    button.onclick = async event => {
      if (!event.isTrusted) return;
      const reply = await chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
      if (!reply.ok) info.textContent = '请点击浏览器工具栏中的「M3U8 下载助手」查看资源。';
    };
    panel.append(close, title, info, button);
    shadow.append(style, panel);
    (document.body || document.documentElement).append(host);
  });
})();
