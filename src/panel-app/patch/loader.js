/* 面板补丁 loader：由桌面端 desktop-dist/index.html 末尾的
   <script src="/kcm/loader.js?v=N"> 引入（N 为载荷内容哈希，
   Electron 子资源缓存不发校验头，只能靠查询参数穿透）。
   职责：kap 源解析 / 资产映射 / 挂载点 / 落盘快照数据桥（usage-daily、external、wallet）。
   数据由 panel-app.js 的直连模式（direct.js）连 kap-server。 */
(() => {
  if (window.__kcmInjected) return;
  window.__kcmInjected = true;

  // 自身版本号：改版只改 index.html 里的 ?v=N，子资源全跟着它走
  let V = '0';
  try {
    V = new URL(document.currentScript.src).searchParams.get('v') || '0';
  } catch (e) { /* 保底 */ }

  // kap 源三级获取：
  // ① URL 的 kimi_origin 参数——桌面端主进程每次加载页面时拼入（最权威，
  //    重启换端口自动跟随）；
  // ② 桌面端 SPA 自己的 sessionStorage['kimi-desktop-server-origin']——
  //    Cmd+R 重载后 URL 不再带参数，但 SPA 的会话存储里就是它定位 kap 用的源；
  // ③ localStorage 缓存——跨客户端重启（重启后 ① 会带新值覆盖）。
  // direct.js 另有 performance 资源记录的第四级兜底。
  try {
    const urlOrigin = new URLSearchParams(location.search).get('kimi_origin');
    if (urlOrigin) {
      window.__kcmKapOrigin = urlOrigin;
      try { localStorage.setItem('kcm.kapOrigin', urlOrigin); } catch (e) { /* 忽略 */ }
    }
    if (!window.__kcmKapOrigin) {
      const spa = sessionStorage.getItem('kimi-desktop-server-origin');
      if (spa) window.__kcmKapOrigin = spa;
    }
    if (!window.__kcmKapOrigin) {
      const cached = localStorage.getItem('kcm.kapOrigin');
      if (cached) window.__kcmKapOrigin = cached;
    }
  } catch (e) { /* 忽略，走兜底 */ }

  // 落盘快照：usage-daily.js（安装器 wire.jsonl 全量扫描）/ external.js /
  // wallet.js 三个文件由安装器与技能写入，都用 script 标签加载——与 loader
  // 自身同一通路，不受页面 CSP 对 fetch 的限制；内容变化才推。
  // 文件缺席（全新环境未预填）属正常：面板从安装时刻开始积累。
  //
  // 诊断状态写全局：面板的状态文案 ticker（status-copy.js）从这里取
  // fileState / kapKnown 归并等级；六段技术串仍由下方状态行展示
  let usageFileState = '载入中';
  let usageLoadedOnce = false;
  const publishDiag = () => {
    try {
      window.__kcmDebug = {
        ...window.__kcmDebug,
        fileState: usageFileState,
        kapKnown: Boolean(window.__kcmKapOrigin)
      };
    } catch (e) { /* 忽略 */ }
  };

  // 轮询：连续失败按指数退避（上限 5 分钟）。文件长期缺席时不必每 30s
  // 往控制台刷一条 404；一旦加载成功立即回到基础节奏。
  const POLL_BACKOFF_MAX_MS = 5 * 60_000;
  const startPolling = ({ src, baseMs, read, onState = () => {}, onPayload }) => {
    let lastText = '';
    let delay = baseMs;
    let timer = null;

    const arm = (ms) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => load(), ms);
    };
    function load(force = false) {
      if (timer) { clearTimeout(timer); timer = null; }
      const s = document.createElement('script');
      s.src = src + '?t=' + Date.now();
      s.onload = () => {
        s.remove();
        delay = baseMs;
        const j = read();
        if (!j || typeof j !== 'object') {
          onState('missing');
          arm(baseMs);
          return;
        }
        onState('loaded');
        // 桥未就绪时不消费内容：去重标记只在推送真正送达后才更新，
        // 否则首轮（bridge 未装好）的加载会把内容记成已推送，之后每轮
        // 轮询都跳过，面板装配完成也等不来数据（panel-ready 补推除外）
        if (!window.__kcm) { arm(baseMs); return; }
        const text = JSON.stringify(j);
        if (!force && text === lastText) { arm(baseMs); return; }
        lastText = text;
        onPayload(j);
        arm(baseMs);
      };
      s.onerror = () => {
        s.remove();
        onState('error');
        arm(delay); // 先按当前节奏重试一次
        delay = Math.min(POLL_BACKOFF_MAX_MS, delay * 2); // 连续失败才逐级退避
      };
      document.head.appendChild(s);
    }
    load();
    return { push: () => load(true) };
  };

  const usagePoller = startPolling({
    src: '/kcm/usage-daily.js',
    baseMs: 30_000,
    read: () => window.__kcmUsageDaily,
    onState: (state) => {
      if (state === 'loaded') {
        usageLoadedOnce = true;
        usageFileState = '已载入';
        return;
      }
      if (state === 'missing') {
        usageFileState = '无历史';
        return;
      }
      // 首次加载失败按「无历史」处理：全新环境安装器不落 usage-daily.js 属正常，
      // 而 onerror 分辨不出「文件不存在」与「文件在但读不了」——只能按是否
      // 成功过判断。文件确实读过一次之后再失败，才是真的异常
      // （状态字典：无历史＝文件缺席；加载失败＝文件在但读不了 → 重装）
      usageFileState = usageLoadedOnce ? '加载失败' : '无历史';
    },
    onPayload: (j) => window.__kcm.push({
      v: 1, type: 'usageDaily',
      daily: j.daily, hourly: j.hourly,
      secondaryModel: j.secondaryModel, connected: true
    })
  });
  // 面板装配完成信号（panel-app bootstrap 派发）：补推一次，消掉首轮时序差
  window.addEventListener('kcm:panel-ready', () => usagePoller.push(), { once: true });

  // 外部账户快照（fetch-external.mjs 产出，60s 轮询；内容变化才推）。
  // 与 usage-daily 同一 script 标签通路与防吞推送规则。
  startPolling({
    src: '/kcm/external.js',
    baseMs: 60_000,
    read: () => window.__kcmExternal,
    onPayload: (j) => window.__kcm.push({ v: 1, type: 'external', providers: j.providers })
  });

  // 加油包余额快照（fetch-wallet.mjs 产出）：以 quota 消息的 wallet 字段
  // 送达（handleQuota 里 limit5h/limit7d 可缺席，只更新余额位）
  startPolling({
    src: '/kcm/wallet.js',
    baseMs: 60_000,
    read: () => window.__kcmWallet,
    onPayload: (j) => window.__kcm.push({ v: 1, type: 'quota', quota: { wallet: j.wallet } })
  });

  // 面板资源同目录直链（shims.resolveResourcePath 优先命中这个映射）
  window.__kcmAssets = {
    'rive/rive.wasm': '/kcm/rive/rive.wasm?v=' + V,
    'rive/kimi_avatar_web-PnsTWI-X.riv': '/kcm/rive/kimi_avatar_web-PnsTWI-X.riv?v=' + V,
    'rive/kimi_avatar_default-srYjF2HV.riv': '/kcm/rive/kimi_avatar_default-srYjF2HV.riv?v=' + V
  };

  // 挂载点与 kimi-code-monitor 扩展一致：aside.side > .col 里 side-footer 之前
  window.__kcmMountInto = (host) => {
    const col = document.querySelector('aside.side > .col');
    if (!col) return false;
    const footer = col.querySelector('.side-footer');
    footer ? col.insertBefore(host, footer) : col.appendChild(host);
    return true;
  };

  // 看门狗：SPA 重绘把面板卸载时挂回；顺带刷新锁位上的诊断状态行
  // （只在数据未到位、锁可见时展示；各环节状态来自 loader 与 direct.js 的 __kcmDebug）
  let watchdogStarted = false;
  const startWatchdog = () => {
    if (watchdogStarted) return;
    watchdogStarted = true;
    setInterval(() => {
      const host = document.getElementById('ksb-panel-host');
      if (host && !host.isConnected) window.__kcmMountInto(host);
      publishDiag();
      const status = document.getElementById('kcm-data-status');
      if (status) {
        const d = window.__kcmDebug || {};
        const path = location.pathname && location.pathname !== '/'
          ? (location.pathname.length > 22 ? location.pathname.slice(0, 22) + '…' : location.pathname)
          : '/';
        status.textContent = [
          '路径 ' + path,
          'kap ' + (window.__kcmKapOrigin ? '已知' : '未知'),
          '数据 ' + usageFileState,
          'WS ' + (d.wsState || '?'),
          '焦点 ' + (d.focusedSid ? String(d.focusedSid).slice(0, 8) : '无'),
          '桥 ' + (d.dispatchError ? '异常' : (d.usageDailyOk ? 'OK' : '?'))
        ].join(' · ');
      }
    }, 1000);
  };

  const boot = () => {
    if (!document.head || !document.querySelector('aside.side > .col')) return false;
    if (!document.getElementById('kcm-panel-css')) {
      const link = document.createElement('link');
      link.id = 'kcm-panel-css';
      link.rel = 'stylesheet';
      link.href = '/kcm/content.css?v=' + V;
      document.head.appendChild(link);
    }
    // Rive 运行库先于面板装配（petStart 读 globalThis.rive）
    const rive = document.createElement('script');
    rive.src = '/kcm/rive/rive.js?v=' + V;
    rive.onload = () => {
      const app = document.createElement('script');
      app.src = '/kcm/panel-app.js?v=' + V;
      document.head.appendChild(app);
    };
    document.head.appendChild(rive);
    startWatchdog();
    return true;
  };
  if (!boot()) {
    const t = setInterval(() => { if (boot()) clearInterval(t); }, 500);
  }
})();
