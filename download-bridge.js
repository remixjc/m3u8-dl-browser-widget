(() => {
  if (globalThis.__m3u8HelperBridgeInstalled) return;
  globalThis.__m3u8HelperBridgeInstalled = true;

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = element => element && element.getClientRects().length > 0;
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:2147483647;max-width:460px;' +
    'padding:14px 18px;border-radius:12px;background:#172033;color:white;font:14px/1.6 system-ui;' +
    'box-shadow:0 8px 32px #0003;white-space:pre-wrap;';
  banner.textContent = '下载助手：正在等待下载表单…';
  (document.body || document.documentElement).append(banner);
  let cancelled = false;
  const cancel = document.createElement('button');
  cancel.textContent = '停止自动填入';
  cancel.style.cssText = 'display:block;margin-top:8px;padding:5px 10px;border:0;border-radius:6px;cursor:pointer;';
  cancel.onclick = () => { cancelled = true; banner.textContent = '自动填入已停止，可手动操作下载网站。'; };
  banner.append(cancel);
  const note = text => { banner.firstChild.textContent = text; };
  function setInput(element, value) {
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function run() {
    const reply = await chrome.runtime.sendMessage({ type: 'GET_HANDOFF' });
    if (!reply.ok) throw new Error(reply.error);
    const pending = reply.data;
    const task = pending.task;
    // 不使用 WebUI 的 autoStart 参数，确保目录填入、鉴权完成后才开始。
    for (let tries = 0; tries < 600; tries++) {
      if (cancelled) return;
      if (document.querySelector('input[type="password"]') &&
          [...document.querySelectorAll('input[type="password"]')].some(visible)) {
        note('下载助手：请先输入下载网站的访问密码，登录后会继续填入。');
        await wait(1000);
        continue;
      }
      const overlays = [...document.querySelectorAll('.modal-overlay')].filter(visible);
      const modal = overlays.find(element =>
        [...element.querySelectorAll('textarea')].some(input => input.value.trim() === task.url));
      if (!modal) { await wait(1000); continue; }
      const name = modal.querySelector('input[class~="focus:ring-green-500"]');
      const directory = modal.querySelector('input[class~="focus:ring-yellow-500"]');
      const urls = [...modal.querySelectorAll('textarea')].find(input => input.value.trim() === task.url);
      let headers = modal.querySelector('textarea[class~="focus:ring-gray-500"]');
      if (!headers) {
        const basic = [...modal.querySelectorAll('.collapse-wrapper > button')].find(button =>
          /^(基本设置|basic settings)$/i.test(button.textContent.trim()));
        if (basic) {
          basic.click();
          await wait(100);
          headers = modal.querySelector('textarea[class~="focus:ring-gray-500"]');
        }
      }
      const submit = [...modal.querySelectorAll('button')].find(button =>
        /^(开始下载|start download)$/i.test(button.textContent.trim()));
      if (!name || !directory || !urls || !headers || !submit) {
        throw new Error('当前网站的表单结构与适配版本不同。地址、名称和请求头已通过链接传入，请手动核对目录。');
      }
      let config;
      try {
        const response = await fetch(new URL('api/config', new URL('../', location.href)), {
          headers: { authorization: localStorage.getItem('token') || '' },
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });
        config = response.ok ? await response.json() : null;
      } catch { config = null; }
      if (config?.code !== 0) {
        note('下载助手：正在等待网站连接成功；如需密码，请先完成登录。');
        await wait(1000);
        continue;
      }
      if (cancelled) return;
      setInput(urls, task.url);
      setInput(name, task.filename);
      setInput(directory, task.saveDir);
      setInput(headers, Object.entries(task.headers).map(([key, value]) => `${key}: ${value}`).join('\n'));
      await wait(100);
      if (cancelled) return;
      if (urls.value !== task.url || name.value !== task.filename || directory.value !== task.saveDir ||
          headers.value !== Object.entries(task.headers).map(([key, value]) => `${key}: ${value}`).join('\n')) {
        throw new Error('表单未保留自动填入的值，请手动核对后提交。');
      }
      const done = await chrome.runtime.sendMessage({ type: 'HANDOFF_DONE' });
      if (!done.ok) throw new Error(done.error);
      // hash 不发送给 HTTP 服务端，但页面加载时仍可被同页脚本读取；填入后立即清除。
      const clean = new URL(location.href);
      clean.hash = '';
      clean.searchParams.delete('helper');
      history.replaceState(history.state, '', clean);
      if (pending.autoStart) {
        if (submit.disabled) throw new Error('下载按钮暂不可用，请在网站内手动提交。');
        note(`已填入 ${task.filename}\n${task.saveDir}\n正在提交，请以网站任务列表显示的结果为准。`);
        cancel.remove();
        submit.click();
      } else {
        note(`已填入 ${task.filename}\n${task.saveDir}\n核对后点击网站的「开始下载」即可。`);
        cancel.remove();
      }
      const close = document.createElement('button');
      close.textContent = '关闭提示';
      close.style.cssText = cancel.style.cssText;
      close.onclick = () => banner.remove();
      banner.append(close);
      return;
    }
    throw new Error('等待表单超时，请重新从插件发送。');
  }
  run().catch(error => {
    note(`下载助手：${error.message}`);
    cancel.textContent = '关闭提示';
    cancel.onclick = () => banner.remove();
  });
})();
