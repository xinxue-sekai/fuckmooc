const http = require('http');
const fs = require('fs');
const path = require('path');
const { paths } = require('./host');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function readJson(req) {
    return new Promise(resolve => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
        });
    });
}

// 密钥类值只回掩码，不回明文
function maskSecret(s) {
    if (!s) return '';
    return s.length <= 7 ? `${s[0]}***` : `${s.slice(0, 3)}****${s.slice(-4)}`;
}

function json(res, code, data, extra = {}) {
    res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...extra
    });
    res.end(JSON.stringify(data));
}

function classifyError(err) {
    const msg = String((err && err.message) || err || '');
    if (/Target closed|Browser closed|browser has been closed|Target page, context or browser has been closed|has been closed/i.test(msg)) {
        return { type: 'closed', msg };
    }
    if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR|Network/i.test(msg)) {
        return { type: 'network', msg };
    }
    return { type: 'error', msg };
}

function createServer({ bus, token, port, state, handlers = {}, configPath = null, profileDir = null }) {
    const p = paths();
    const cfgFile = configPath || p.config;
    const profilePath = profileDir || p.icourseProfile;
    const uiDir = path.join(p.root, 'ui');
    const expectedHost = `127.0.0.1:${port}`;
    const pkg = require('../package.json');

    // 旧版把运行方式开关存在 gui-prefs.json；启动时迁到 config.txt（幂等）
    require('./config-service').migrateLegacyRunMode(cfgFile);

    const server = http.createServer(async (req, res) => {
        const u = new URL(req.url, `http://${expectedHost}`);
        const name = u.pathname;

        if ((req.headers.host || '') !== expectedHost) {
            json(res, 403, { error: 'forbidden' });
            return;
        }

        if (name === '/api/health') {
            json(res, 200, { ok: true, phase: state.get().phase, version: pkg.version }, { 'x-fuckmooc-app': '1' });
            return;
        }

        if (name === '/api/events') {
            if (u.searchParams.get('token') !== token) {
                json(res, 401, { error: 'unauthorized' });
                return;
            }
            const lastId = Number(req.headers['last-event-id'] || u.searchParams.get('lastEventId') || 0);
            const off = bus.subscribeSSE(res, lastId);
            req.on('close', off);
            return;
        }

        if (name === '/api/state') {
            json(res, 200, state.get());
            return;
        }

        if (name === '/api/config') {
            const { num } = require('./config');
            const svc = require('./config-service');
            const cfg = svc.getSettings(cfgFile);
            const runMode = svc.getRunMode(cfgFile);
            const ui = svc.getUiState();
            const courses = String(cfg.ICOURSE_COURSE_URL || '')
                .split(/[\n,]/).map(s => s.trim()).filter(Boolean)
                .map(url => {
                    const k = url.match(/([A-Za-z]+-\d+)/);
                    const t = url.match(/[?&]tid=(\d+)/);
                    return { url, courseKey: k ? k[1] : '', termId: t ? t[1] : '' };
                })
                .filter(c => c.courseKey);

            json(res, 200, {
                courses,
                activeCourse: cfg.ICOURSE_ACTIVE_COURSE || null,
                advanced: {
                    probe: runMode.probe, quiz: runMode.quiz,
                    noQuiz: runMode.noQuiz, drill: runMode.drill,
                    limit: runMode.limit,
                    playbackRate: num(cfg.ICOURSE_PLAYBACK_RATE, 2),
                    documentStayMs: num(cfg.ICOURSE_DOCUMENT_STAY_MS, 35000),
                    quizBudgetMs: num(cfg.ICOURSE_QUIZ_BUDGET_MS, 25 * 60 * 1000),
                    missRatio: num(cfg.ICOURSE_QUIZ_MAX_MISS_RATIO, 0.2)
                },
                llm: {
                    enabled: String(cfg.LLM_ENABLED || '').toLowerCase() === 'true',
                    provider: cfg.LLM_PROVIDER || 'deepseek',
                    baseUrl: cfg.LLM_BASE_URL || '',
                    model: cfg.LLM_MODEL || '',
                    keySet: !!cfg.LLM_API_KEY,
                    keyMask: maskSecret(cfg.LLM_API_KEY || '')
                },
                font: ui.font || 'normal',
                theme: ui.theme || 'auto',
                closeAction: ui.closeAction || 'ask',
                llmCatalog: ui.llmCatalog || {},
                onboarded: !!ui.onboarded
            });
            return;
        }

        if (name === '/api/records') {
            const progress = require('./progress');
            const all = progress.readAll();
            let done = 0, failed = 0, total = 0;
            for (const c of Object.values(all)) {
                for (const t of Object.values((c && c.tasks) || {})) {
                    total++;
                    if (t.status === 'done') done++; else failed++;
                }
            }
            json(res, 200, {
                stats: { done, failed, total },
                logCount: progress.listLogFiles().length,
                loggedIn: fs.existsSync(path.join(profilePath, '.logged-in')),
                canRestore: progress.backupExists() || fs.existsSync(profilePath + '.bak')
            });
            return;
        }

        if (name === '/api/logs') {
            json(res, 200, { items: require('./progress').listLogFiles() });
            return;
        }

        if (name === '/api/logs/export') {
            res.writeHead(200, {
                'content-type': 'text/plain; charset=utf-8',
                'content-disposition': 'attachment; filename="fuckmooc-log.txt"'
            });
            res.end(bus.history(0).filter(e => e.type === 'log')
                .map(e => `${e.ts}  ${e.tag || '系统'}  ${e.text || ''}`).join('\n'));
            return;
        }

        if (req.method === 'POST' && u.searchParams.get('token') !== token && req.headers['x-fuckmooc-token'] !== token) {
            json(res, 401, { error: 'unauthorized' });
            return;
        }

        if (name.startsWith('/api/config/')) {
            const body = await readJson(req);
            const svc = require('./config-service');

            if (name === '/api/config/icourse') {
                // 逐项校验：无效项返回字段级错误，不再静默丢弃
                const list = Array.isArray(body.courses) ? body.courses : [];
                for (let i = 0; i < list.length; i++) {
                    const c = list[i] || {};
                    const okUrl = /^https?:\/\//.test(String(c.url || ''));
                    const okKey = /^[A-Za-z]+-\d+$/.test(String(c.courseKey || ''));
                    if (!okUrl || !okKey) {
                        json(res, 400, { error: 'invalid course', fields: { courses: `第 ${i + 1} 项不是有效的课程地址（需要 http(s) 开头且带课程编号）` } });
                        return;
                    }
                }
                svc.setCourses(list, cfgFile);
                if (body.activeCourse !== undefined) svc.setActiveCourse(body.activeCourse, cfgFile);
            } else if (name === '/api/config/advanced') {
                // 运行方式缺失不覆盖（R1 治本）：只写调用方给出的键，局部保存不影响其他开关
                const runPatch = {};
                for (const k of ['probe', 'quiz', 'noQuiz', 'drill']) {
                    if (body[k] !== undefined) runPatch[k] = !!body[k];
                }
                if (body.limit !== undefined) runPatch.limit = Number(body.limit) || 0;
                svc.setRunMode(runPatch, cfgFile);
                const patch = {};
                if (body.playbackRate) patch.ICOURSE_PLAYBACK_RATE = String(body.playbackRate);
                if (body.documentStayMs) patch.ICOURSE_DOCUMENT_STAY_MS = String(body.documentStayMs);
                if (body.quizBudgetMs) patch.ICOURSE_QUIZ_BUDGET_MS = String(body.quizBudgetMs);
                if (body.missRatio !== undefined) patch.ICOURSE_QUIZ_MAX_MISS_RATIO = String(body.missRatio);
                if (Object.keys(patch).length) svc.setAdvanced(patch, cfgFile);
            } else if (name === '/api/config/llm') {
                // 答题模型配置（OpenAI 兼容）：白名单 + 启用时必填校验
                const patch = {};
                if (body.enabled !== undefined) patch.LLM_ENABLED = String(!!body.enabled);
                if (body.provider !== undefined && ['deepseek', 'custom'].includes(body.provider)) patch.LLM_PROVIDER = body.provider;
                if (body.baseUrl !== undefined) patch.LLM_BASE_URL = String(body.baseUrl).trim().replace(/\/+$/, '');
                if (body.apiKey) patch.LLM_API_KEY = String(body.apiKey).trim();
                if (body.model !== undefined) patch.LLM_MODEL = String(body.model).trim();
                if (body.enabled === true && (!patch.LLM_BASE_URL || !patch.LLM_MODEL)) {
                    json(res, 400, { error: 'need base url and model', fields: { baseUrl: '启用时必须填写 API 地址与模型' } });
                    return;
                }
                if (Object.keys(patch).length) svc.setAdvanced(patch, cfgFile);
            } else if (name === '/api/config/prefs') {
                // 界面状态白名单：onboarded / 字号 / 主题，其余键忽略
                const patch = {};
                for (const k of ['onboarded', 'font', 'theme', 'closeAction', 'llmCatalog']) {
                    if (body[k] !== undefined) patch[k] = body[k];
                }
                if (Object.keys(patch).length) svc.setUiState(patch);
            } else {
                json(res, 404, { error: 'not found' });
                return;
            }
            json(res, 200, { ok: true });
            return;
        }

        if (name === '/api/records/clear') {
            const body = await readJson(req);
            if (!body.confirm) {
                json(res, 400, { error: 'need confirm' });
                return;
            }
            const progress = require('./progress');
            const type = body.type || 'progress';
            // 清空之前先备份（保留最近一代），界面可一键恢复
            if (type === 'progress') { progress.backupProgress(); progress.clearAll(); }
            else if (type === 'logs') { progress.backupLogs(); progress.clearLogs(); }
            else if (type === 'profile') {
                fs.rmSync(profilePath + '.bak', { recursive: true, force: true });
                try { fs.renameSync(profilePath, profilePath + '.bak'); } catch {}
            } else {
                json(res, 400, { error: 'unknown type' });
                return;
            }
            bus.emit('log', { level: 'warn', tag: '系统', text: `已清空${type === 'profile' ? '登录态' : type === 'logs' ? '运行日志' : '完成记录'}，可在记录页恢复` });
            json(res, 200, { ok: true });
            return;
        }

        if (name === '/api/records/restore') {
            const body = await readJson(req);
            if (!body.confirm) {
                json(res, 400, { error: 'need confirm' });
                return;
            }
            // 登录态备份只有在当前位置没有新登录态时才能恢复，避免覆盖重新扫码的结果
            if (fs.existsSync(profilePath + '.bak') && fs.existsSync(profilePath)) {
                json(res, 409, { error: 'profile exists' });
                return;
            }
            const progress = require('./progress');
            let restored = progress.restoreBackup();
            if (fs.existsSync(profilePath + '.bak')) {
                fs.renameSync(profilePath + '.bak', profilePath);
                restored++;
            }
            bus.emit('log', { level: 'info', tag: '系统', text: `已恢复上次清空的数据（${restored} 项）` });
            json(res, 200, { ok: true, restored });
            return;
        }

        if (name === '/api/task/confirm') {
            const body = await readJson(req);
            const ok = typeof handlers.confirm === 'function'
                ? handlers.confirm(body.id, body.choice, body.noMore)
                : false;
            json(res, ok ? 200 : 404, { ok });
            return;
        }

        if (name === '/api/task/start') {
            if (typeof handlers.assertContext === 'function' && !handlers.assertContext()) {
                json(res, 409, { error: 'context not injected' });
                return;
            }
            if (state.get().running) {
                json(res, 409, { error: 'busy' });
                return;
            }
            const body = await readJson(req);
            const { getRunMode } = require('./config-service');
            const runMode = getRunMode(cfgFile);
            const options = {
                probe: body.probe !== undefined ? !!body.probe : runMode.probe,
                quiz: body.quiz !== undefined ? !!body.quiz : runMode.quiz,
                noQuiz: body.noQuiz !== undefined ? !!body.noQuiz : runMode.noQuiz,
                drill: body.drill !== undefined ? !!body.drill : runMode.drill,
                limit: Number(body.limit !== undefined ? body.limit : runMode.limit) || 0,
                submit: false,
                courses: null
            };

            const { getCourses } = require('./config-service');
            if (getCourses(cfgFile).courses.length === 0) {
                json(res, 400, { error: 'no courses' });
                return;
            }

            state.set({ running: true, paused: false, phase: 'env-check', label: '环境检查' });
            if (typeof handlers.beginRun === 'function') handlers.beginRun();
            bus.emit('log', { level: 'info', tag: '系统', text: '开始处理课程' });

            Promise.resolve()
                .then(() => {
                    if (typeof handlers.startTask !== 'function') throw new Error('任务启动器未接入');
                    return handlers.startTask(options);
                })
                .catch(err => {
                    const e = classifyError(err);
                    bus.emit('log', { level: 'error', tag: '系统', text: e.msg });
                    if (e.type === 'closed') {
                        bus.emit('intervention', {
                            kind: 'browser-closed',
                            title: '课程浏览器被关闭',
                            message: '任务已中断。可以重新打开浏览器继续，已完成的记录会保留。',
                            blocking: true,
                            choices: ['重新打开并继续', '停止任务']
                        });
                    } else if (e.type === 'network') {
                        bus.emit('toast', { level: 'warn', text: '网络异常，任务已中断；恢复后可再运行一次，已完成的会跳过' });
                    } else {
                        bus.emit('toast', { level: 'error', text: `任务中断：${e.msg}` });
                    }
                })
                .finally(() => {
                    if (typeof handlers.endRun === 'function') handlers.endRun();
                    state.set({ running: false, paused: false, phase: 'done', label: '已结束' });
                });

            json(res, 200, { ok: true });
            return;
        }

        if (name.startsWith('/api/task/')) {
            if (name.endsWith('/stop')) {
                state.set({ running: false, paused: false, phase: 'stopped', label: '已停止' });
                if (typeof handlers.controlStop === 'function') handlers.controlStop();
                if (typeof handlers.endRun === 'function') handlers.endRun();
            } else if (name.endsWith('/pause')) {
                if (!state.get().running) {
                    json(res, 409, { error: 'not running' });
                    return;
                }
                state.set({ paused: true, phase: 'paused', label: '已暂停' });
                if (typeof handlers.controlPause === 'function') handlers.controlPause();
            } else if (name.endsWith('/resume')) {
                state.set({ paused: false, phase: 'running', label: '运行中' });
                if (typeof handlers.controlResume === 'function') handlers.controlResume();
            }
            json(res, 200, { ok: true });
            return;
        }

        if (name === '/api/llm/models') {
            // 代理转发 OpenAI 兼容的模型列表：页面直连第三方会有跨域限制
            const body = await readJson(req);
            const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
            const apiKey = String(body.apiKey || '').trim();
            if (!/^https?:\/\//.test(baseUrl)) {
                json(res, 400, { error: 'invalid base url' });
                return;
            }
            try {
                const r = await fetch(baseUrl + '/models', {
                    headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {},
                    signal: AbortSignal.timeout(10000)
                });
                const data = await r.json().catch(() => ({}));
                const ids = (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
                if (!r.ok) {
                    json(res, 400, { error: `模型列表获取失败（HTTP ${r.status}）` });
                    return;
                }
                json(res, 200, { models: ids });
            } catch (e) {
                json(res, 400, { error: '模型列表获取失败：' + (e.name === 'AbortError' ? '请求超时' : e.message) });
            }
            return;
        }

        if (name === '/api/install/retry') {
            if (typeof handlers.installRetry === 'function') handlers.installRetry();
            json(res, 200, { ok: true });
            return;
        }

        if (name === '/api/app/close-decision') {
            const body = await readJson(req);
            const choice = body.choice === 'exit' ? 'exit' : 'tray';
            if (typeof handlers.closeDecision === 'function') handlers.closeDecision(choice, !!body.remember);
            json(res, 200, { ok: true });
            return;
        }

        if (name === '/api/window/closing') {
            state.set({ windowVisible: false });
            json(res, 200, { ok: true });
            return;
        }

        if (name === '/api/window/recall') {
            state.set({ windowVisible: true });
            if (typeof handlers.recall === 'function') handlers.recall();
            json(res, 200, { ok: true });
            return;
        }

        if (name === '/api/app/quit') {
            json(res, 200, { ok: true });
            setImmediate(() => { if (typeof handlers.quit === 'function') handlers.quit(); });
            return;
        }

        const rel = name === '/' ? 'index.html' : name.replace(/^\/+/, '');
        const file = path.resolve(uiDir, rel);
        if (!file.startsWith(path.resolve(uiDir))) {
            json(res, 403, { error: 'forbidden' });
            return;
        }
        fs.readFile(file, (err, buf) => {
            if (err) {
                json(res, 404, { error: 'not found' });
                return;
            }
            res.writeHead(200, {
                'content-type': MIME[path.extname(file)] || 'application/octet-stream',
                'cache-control': 'no-store'
            });
            res.end(buf);
        });
    });

    function listen() {
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => resolve(server));
        });
    }

    function close() {
        return new Promise(resolve => server.close(() => resolve()));
    }

    return { server, listen, close };
}

module.exports = { createServer, classifyError };
