// 统一请求层：业务代码不直接调 fetch。
// 豁免两点：日志导出用 window.open（触发下载）、关窗上报用 sendBeacon（页面卸载期）。
// 错误归一化：network（连不上）/ timeout / http（4xx 5xx，code 取后端 error 字段）。

const FM = {
    token: new URLSearchParams(location.search).get('token') || '',
    inflight: new Map(),
    lastNetToast: 0,
    cache: new Map()
};

function fmNotify(text, level = 'error') {
    if (typeof toast === 'function') toast(text, level);
    else console.warn(`[提示] ${text}`);
}

// name: 契约名（contracts.js），用于运行时校验；未知名跳过校验
async function fmRequest(name, path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const sep = path.includes('?') ? '&' : '?';
        const r = await fetch(`${path}${sep}token=${FM.token}`, {
            method,
            headers: { 'content-type': 'application/json', 'x-fuckmooc-token': FM.token },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ctrl.signal
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            if (r.status === 401 || r.status === 403) fmNotify('窗口连接失效，请重新打开 fuckmooc');
            return { ok: false, status: r.status, code: String(data.error || ''), data };
        }
        if (typeof fmValidate === 'function') fmValidate(name || `${method} ${path}`, data);
        return { ok: true, status: 200, code: '', data };
    } catch (e) {
        const kind = e && e.name === 'AbortError' ? 'timeout' : 'network';
        // 网络类失败统一人话提示；3 秒内不重复刷屏
        const now = Date.now();
        if (now - FM.lastNetToast > 3000) {
            fmNotify(kind === 'timeout' ? '服务响应超时，请稍后再试' : '连不上本地服务，请确认程序还在运行');
            FM.lastNetToast = now;
        }
        return { ok: false, status: 0, code: kind, data: {} };
    } finally {
        clearTimeout(timer);
    }
}

// GET 去重：同路径的在途请求复用同一个 Promise，避免并发重复请求
function fmGet(name, path) {
    if (FM.inflight.has(path)) return FM.inflight.get(path);
    const p = fmRequest(name, path).finally(() => FM.inflight.delete(path));
    FM.inflight.set(path, p);
    return p;
}

// ---------- 服务端状态 mini store：缓存 + 精确失效 ----------

async function fmQuery(name, path) {
    const res = await fmGet(name, path);
    if (res.ok) FM.cache.set(name, res.data);
    return res;
}

function fmInvalidate(...names) {
    for (const n of names) FM.cache.delete(n);
}

function fmCached(name) {
    return FM.cache.get(name) || null;
}
