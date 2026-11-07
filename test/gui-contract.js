// GUI 契约测试：纯逻辑，不启浏览器、不 spawn Playwright。
// 与 test/smoke.js 的 test() 同构（同步/异步均可），内存 HTTP 服务 + fetch 验证 /api/* 契约。
// 运行：node test/gui-contract.js
// 基准：gui-frozen-contract.md v1.1；断言一律用函数名 / 选择器 / 行为描述，不绑源码行号。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = 'gui-contract-token';

const { createBus } = require('../core/event-bus');
const { noopCtx, createContext, runWithContext, current } = require('../core/run-context');
const { parseArgs } = require('../core/cli-options');
const sinks = require('../core/log-sinks');
const { submitQuiz } = require('../platform/icourse163/quiz');

// C2：/api/config 经 core/config-service.getSettings 读配置。
// 把读取重定向到系统临时目录的临时文件，既不依赖也不写入用户 config.txt。
const realService = require('../core/config-service');
const TEMP_CFG = {
    ICOURSE_COURSE_URL: 'https://www.icourse163.org/learn/XXXX-1234567?tid=8901234',
    ICOURSE_ACTIVE_COURSE: 'XXXX-1234567',
    LLM_API_KEY: 'sk-test-abcdef1234567890'
};
const TMP_CONFIG = path.join(os.tmpdir(), `fuckmooc-gui-contract-cfg-${process.pid}.txt`);
function writeTempConfig() {
    fs.writeFileSync(TMP_CONFIG, [
        '# gui-contract 临时配置（不进项目仓库）',
        `ICOURSE_COURSE_URL=${TEMP_CFG.ICOURSE_COURSE_URL}`,
        `ICOURSE_ACTIVE_COURSE=${TEMP_CFG.ICOURSE_ACTIVE_COURSE}`,
        `LLM_API_KEY=${TEMP_CFG.LLM_API_KEY}`,
        ''
    ].join('\n'), 'utf-8');
}
writeTempConfig();
const serviceModulePath = require.resolve('../core/config-service');
// 原地打桩而不是整体替换 exports：quiz 在打桩前就已加载平台 config，
// 后者持有 config-service 模块对象的引用，整体替换会让它继续读到真实配置
Object.assign(require.cache[serviceModulePath].exports, {
    getSettings: () => realService.readAll(TMP_CONFIG)
});
const { createServer, classifyError } = require('../core/http-server');
const { emitTasks } = require('../platform/icourse163/learn');
const progress = require('../core/progress');

// 所有写操作都指向临时目录，不碰项目里的 config.txt / progress.json / 登录态
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `fuckmooc-gui-contract-${process.pid}-`));
const TMP_PROGRESS = path.join(TMP_DIR, 'progress.json');
const REAL_PROGRESS_FILE = progress.FILE;
progress.useFile(TMP_PROGRESS);

// 界面状态（onboarded/font/theme）重定向到临时文件，测试结束自动清理
const TMP_PREFS = path.join(TMP_DIR, 'gui-prefs.json');
require('../core/prefs').useFile(TMP_PREFS);

const log = () => {};

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(
            () => { console.log(`  [通过] ${name}`); passed++; },
            e => { console.log(`  [失败] ${name} → ${e.message}`); failed++; }
        );
}

function skip(name, reason) {
    console.log(`  [跳过] ${name}（二期：${reason}）`);
    skipped++;
}

// 纯 mock page：不碰真实浏览器。submitQuiz 点 .j-submitBtn 即记录，平台弹层分支不触发。
// getByText 按真实契约给 count/nth（可见性检查用），这里返回 0 个匹配让确认循环直接跳过。
function fakePage(calls = []) {
    return {
        locator: () => ({
            first: () => ({
                count: async () => 1,
                click: async () => { calls.push('submit-click'); }
            })
        }),
        getByText: () => ({ count: async () => 0 }),
        waitForTimeout: async () => {},
        evaluate: async () => ({ ok: true, why: '已进入成绩页' })
    };
}

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

function api(port, name, { method = 'GET', body, headers = {} } = {}) {
    const suffix = method === 'POST' ? `?token=${TOKEN}` : '';
    return fetch(`http://127.0.0.1:${port}${name}${suffix}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
}

// 绕过 api() 助手直接发原始请求：用于鉴权（无 token / 错 token / 错 Host）测试
function rawGet(port, name, headers = {}) {
    return new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port, path: name, headers }, res => {
            res.resume();
            resolve(res.statusCode);
        });
        req.on('error', () => resolve(0));
    });
}

function readSSE(port, lastId, ms = 250) {
    return new Promise(resolve => {
        let buf = '';
        let done = false;
        const finish = v => { if (!done) { done = true; resolve(v); } };
        const req = http.get({
            host: '127.0.0.1',
            port,
            path: `/api/events?token=${TOKEN}`,
            headers: { Host: `127.0.0.1:${port}`, 'Last-Event-ID': String(lastId) }
        }, res => {
            res.on('data', c => { buf += c.toString(); });
            setTimeout(() => { req.destroy(); finish(buf); }, ms);
        });
        req.on('error', () => finish(buf));
    });
}

async function main() {
    const port = await freePort();
    const bus = createBus();
    const stateData = { running: false, paused: false, phase: 'idle', label: '' };
    const state = {
        get: () => ({ ...stateData }),
        set: patch => Object.assign(stateData, patch)
    };
    let guiInjected = false;
    let guiCtx = null;
    const started = [];
    const handlers = {
        assertContext: () => guiInjected,
        confirm: (id, choice, noMore) => guiCtx ? guiCtx.resolveConfirm(id, choice, noMore) : false,
        // 真实启动器：挂住 Promise 模拟长任务，便于验证并发期间的 busy 锁
        startTask: (opts) => { started.push(opts); return new Promise(() => {}); }
    };
    const srv = createServer({
        bus, token: TOKEN, port, state, handlers,
        configPath: TMP_CONFIG, profileDir: path.join(TMP_DIR, 'profile')
    });
    await srv.listen();

    console.log('\n【HTTP 契约 C1–C5、C11】');

    await test('C1 /api/health 返回 x-fuckmooc-app: 1', async () => {
        const r = await api(port, '/api/health');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('x-fuckmooc-app'), '1');
    });

    await test('C2 /api/config 返回课程与运行方式，密钥只回掩码', async () => {
        const r = await api(port, '/api/config');
        assert.strictEqual(r.status, 200);
        const text = await r.text();
        assert.ok(!text.includes(TEMP_CFG.DEEPSEEK_API_KEY), '响应体不得含 API Key 明文');
        const body = JSON.parse(text);
        assert.strictEqual(body.courses.length, 1);
        assert.strictEqual(body.courses[0].courseKey, 'XXXX-1234567');
        assert.strictEqual(body.activeCourse, 'XXXX-1234567');
        assert.strictEqual(typeof body.advanced.playbackRate, 'number');
        assert.strictEqual(body.font, 'normal');
        assert.strictEqual(body.theme, 'auto');
        assert.strictEqual(body.closeAction, 'ask');
        assert.strictEqual(typeof body.llm, 'object');
        assert.strictEqual(body.llm.keySet, true);
        assert.strictEqual(body.llm.keyMask, 'sk-****7890');
        assert.strictEqual(body.llm.enabled, false);
        assert.strictEqual(typeof body.onboarded, 'boolean');
        assert.strictEqual(body.deepseekEnabled, undefined, '旧 DeepSeek 字段应已移除');
    });

    await test('C2d config-service.readAll 用临时文件解析，不碰用户 config.txt', () => {
        const tmp = path.join(os.tmpdir(), `fuckmooc-gui-contract-read-${process.pid}.txt`);
        try {
            fs.writeFileSync(tmp, '# 注释行\nICOURSE_ACTIVE_COURSE=abc=def\nICOURSE_COURSE_URL=https://www.icourse163.org/learn/XXXX-1234567?tid=8901234\nEMPTY=\n', 'utf-8');
            const cfg = realService.readAll(tmp);
            assert.strictEqual(cfg.ICOURSE_ACTIVE_COURSE, 'abc=def', '含 = 的值需完整保留');
            assert.strictEqual(cfg.ICOURSE_COURSE_URL, 'https://www.icourse163.org/learn/XXXX-1234567?tid=8901234');
            assert.ok(!Object.prototype.hasOwnProperty.call(cfg, 'EMPTY'), '空值视为未设置');
            assert.ok(!Object.prototype.hasOwnProperty.call(cfg, '# 注释行'));
        } finally {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        }
    });

    await test('C2e /api/config/prefs 读写界面状态（font/theme/closeAction），白名单外不落盘', async () => {
        const r = await api(port, '/api/config/prefs', { method: 'POST', body: { font: 'large', theme: 'dark', closeAction: 'exit' } });
        assert.strictEqual(r.status, 200);
        let body = await (await api(port, '/api/config')).json();
        assert.strictEqual(body.font, 'large');
        assert.strictEqual(body.theme, 'dark');
        assert.strictEqual(body.closeAction, 'exit');
        await api(port, '/api/config/prefs', { method: 'POST', body: { hack: 'x' } });
        assert.strictEqual(realService.getUiState().hack, undefined, '白名单外的键不得写入');
        await api(port, '/api/config/prefs', { method: 'POST', body: { font: 'normal', theme: 'auto', closeAction: 'ask' } });
        body = await (await api(port, '/api/config')).json();
        assert.strictEqual(body.font, 'normal');
        assert.strictEqual(body.theme, 'auto');
        assert.strictEqual(body.closeAction, 'ask');
    });

    await test('C2i 旧版运行方式开关自动迁入 config.txt', () => {
        require('../core/prefs').setPrefs({ probe: true, drill: true, limit: 3, onboarded: true });
        assert.strictEqual(realService.migrateLegacyRunMode(TMP_CONFIG), true);
        const text = fs.readFileSync(TMP_CONFIG, 'utf-8');
        assert.ok(text.includes('RUN_PROBE=true'), 'probe 须迁入');
        assert.ok(text.includes('RUN_DRILL=true'), 'drill 须迁入');
        assert.ok(text.includes('RUN_LIMIT=3'), 'limit 须迁入');
        assert.ok(!text.includes('RUN_QUIZ='), '默认值不迁移，配置保持干净');
        const prefs = require('../core/prefs').getPrefs();
        assert.strictEqual(prefs.probe, undefined, '迁移后旧键须从 prefs 剔除');
        assert.strictEqual(prefs.onboarded, true, '界面状态保留');
        assert.strictEqual(realService.migrateLegacyRunMode(TMP_CONFIG), false, '幂等：无旧键时不再写');
    });

    await test('C2j /api/config/advanced 缺失不覆盖（R1 回归）', async () => {
        realService.setRunMode({ probe: true, limit: 3 }, TMP_CONFIG);
        // 只发 DeepSeek 字段（向导的保存形态），不得把 probe/limit 重置
        const r = await api(port, '/api/config/advanced', { method: 'POST', body: { deepseekEnabled: true } });
        assert.strictEqual(r.status, 200);
        const runMode = realService.getRunMode(TMP_CONFIG);
        assert.strictEqual(runMode.probe, true, '局部保存不得重置其他开关');
        assert.strictEqual(runMode.limit, 3);
        realService.setRunMode({ probe: false, limit: 0 }, TMP_CONFIG);
    });

    await test('C2k /api/config/icourse 非法课程项返回字段级错误（不再静默丢弃）', async () => {
        const bad = await api(port, '/api/config/icourse', { method: 'POST', body: { courses: [
            { url: TEMP_CFG.ICOURSE_COURSE_URL, courseKey: 'XXXX-1234567', termId: '8901234' },
            { url: 'notaurl', courseKey: '' }
        ] } });
        assert.strictEqual(bad.status, 400);
        const b = await bad.json();
        assert.strictEqual(b.error, 'invalid course');
        assert.match(b.fields.courses, /第 2 项/);
        const ok = await api(port, '/api/config/icourse', { method: 'POST', body: { courses: [
            { url: TEMP_CFG.ICOURSE_COURSE_URL, courseKey: 'XXXX-1234567', termId: '8901234' }
        ], activeCourse: 'XXXX-1234567' } });
        assert.strictEqual(ok.status, 200);
    });

    await test('C2f reloadSettings 反映配置变更（GUI 改设置下一场生效）', () => {
        const { reloadSettings, settings: plat } = require('../platform/icourse163/config');
        writeTempConfig();
        fs.appendFileSync(TMP_CONFIG, 'ICOURSE_QUIZ_BUDGET_MS=12345678\nICOURSE_ACTIVE_COURSE=ZZZZ-9999999\n', 'utf-8');
        reloadSettings();
        assert.strictEqual(plat.QUIZ_BUDGET_MS, 12345678);
        assert.strictEqual(plat.ACTIVE_COURSE, 'ZZZZ-9999999');
        writeTempConfig();
        reloadSettings();
        assert.notStrictEqual(plat.QUIZ_BUDGET_MS, 12345678, '恢复临时配置后须回到默认值');
    });

    await test('C2g /api/config/llm 保存模型配置且只回掩码', async () => {
        const r = await api(port, '/api/config/llm', { method: 'POST', body: {
            enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-new-1234567890wxyz'
        } });
        assert.strictEqual(r.status, 200);
        const text = await (await api(port, '/api/config')).text();
        assert.ok(!text.includes('sk-new-1234567890wxyz'), '响应体不得含新 Key 明文');
        const body = JSON.parse(text);
        assert.strictEqual(body.llm.enabled, true);
        assert.strictEqual(body.llm.baseUrl, 'https://api.deepseek.com');
        assert.strictEqual(body.llm.model, 'deepseek-chat');
        assert.strictEqual(body.llm.keySet, true);
        assert.strictEqual(body.llm.keyMask, 'sk-****wxyz');
        writeTempConfig();
    });

    await test('C2l 启用模型但缺地址/模型 → 400 字段级错误', async () => {
        const r = await api(port, '/api/config/llm', { method: 'POST', body: { enabled: true } });
        assert.strictEqual(r.status, 400);
        assert.strictEqual((await r.json()).error, 'need base url and model');
    });

    await test('C2m 桌面快捷方式脚本拼装（BOM/路径/图标）', () => {
        const { buildShortcutScript } = require('../core/http-server');
        const s = buildShortcutScript('D:\\proj', 'D:\\proj\\ui\\tray.ico');
        assert.strictEqual(s.charCodeAt(0), 0xFEFF, '须带 UTF-8 BOM，否则 PowerShell 5.1 中文解析出错');
        assert.ok(s.includes("fuckmooc.lnk"), '桌面文件名');
        assert.ok(s.includes('D:\\proj\\start.vbs'), '目标 start.vbs');
        assert.ok(s.includes('D:\\proj\\ui\\tray.ico,0'), '图标 tray.ico');
        assert.ok(s.includes("GetFolderPath('Desktop')"), '桌面路径解析');
        assert.ok(s.includes("$lnk.Save()"), '保存动作');
    });

    await test('C2h onboarded 标记经 prefs 置位后可读回', async () => {
        await api(port, '/api/config/prefs', { method: 'POST', body: { onboarded: true } });
        assert.strictEqual((await (await api(port, '/api/config')).json()).onboarded, true);
        await api(port, '/api/config/prefs', { method: 'POST', body: { onboarded: false } });
    });

    await test('C3a /api/records/clear 缺 confirm 返回 400', async () => {
        const r = await api(port, '/api/records/clear', { method: 'POST', body: {} });
        assert.strictEqual(r.status, 400);
        const body = await r.json();
        assert.strictEqual(body.error, 'need confirm');
    });

    await test('C3b /api/records/clear 带 confirm 真实清空完成记录', async () => {
        progress.mark('TEST-COURSE', 'cid-1', { type: '视频', title: '测试', status: 'done' });
        assert.ok(Object.keys(progress.readAll()).length > 0, '先写入一条临时记录');
        const r = await api(port, '/api/records/clear', {
            method: 'POST', body: { confirm: true, type: 'progress' }
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(Object.keys(progress.readAll()).length, 0, '完成记录须被清空');
    });

    await test('C3c /api/records/clear 未知类型返回 400', async () => {
        const r = await api(port, '/api/records/clear', { method: 'POST', body: { confirm: true, type: 'nope' } });
        assert.strictEqual(r.status, 400);
    });

    await test('C3d type=profile 真实删除 profile 目录（临时目录隔离）', async () => {
        const profileDir = path.join(TMP_DIR, 'profile');
        fs.mkdirSync(profileDir, { recursive: true });
        fs.writeFileSync(path.join(profileDir, 'Cookies'), 'x', 'utf-8');
        const r = await api(port, '/api/records/clear', { method: 'POST', body: { confirm: true, type: 'profile' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(fs.existsSync(profileDir), false, '清空登录态须删掉 profile 目录本身');
        assert.strictEqual(fs.existsSync(profileDir + '.bak'), true, '清空须留下备份');
        fs.rmSync(profileDir + '.bak', { recursive: true, force: true });
    });

    await test('C3e 清空完成记录后可从备份恢复', async () => {
        progress.mark('TEST-COURSE', 'cid-9', { type: '视频', title: '恢复测试', status: 'done' });
        await api(port, '/api/records/clear', { method: 'POST', body: { confirm: true, type: 'progress' } });
        assert.strictEqual(Object.keys(progress.readAll()).length, 0, '清空后为空');
        assert.strictEqual(progress.backupExists(), true, '备份存在');
        await api(port, '/api/records/restore', { method: 'POST', body: { confirm: true } });
        assert.strictEqual(progress.readAll()['TEST-COURSE']?.tasks?.['cid-9']?.status, 'done', '恢复后记录回来');
    });

    await test('C4a SSE 事件补发：history(lastId) 只返回 id > lastId', () => {
        const b = createBus();
        const e1 = b.emit('log', { text: 'a' });
        const e2 = b.emit('log', { text: 'b' });
        const e3 = b.emit('log', { text: 'c' });
        assert.deepStrictEqual(b.history(e1.id).map(x => x.id), [e2.id, e3.id]);
        assert.deepStrictEqual(b.history(e3.id), []);
    });

    await test('C4b /api/events 带 Last-Event-ID 只补发后续事件', async () => {
        const before = bus.history(0);
        const lastId = before.length ? before[before.length - 1].id : 0;
        const a = bus.emit('log', { level: 'info', tag: '契约', text: '补发甲' });
        const b = bus.emit('log', { level: 'info', tag: '契约', text: '补发乙' });
        const text = await readSSE(port, lastId);
        assert.ok(!text.includes(`id: ${lastId}\n`), '不得补发 id <= lastId 的历史');
        assert.ok(text.includes(`id: ${a.id}\n`), '应补发第一条后续事件');
        assert.ok(text.includes(`id: ${b.id}\n`), '应补发第二条后续事件');
    });

    await test('C5a /api/task/start 上下文未注入 → 409 context not injected', async () => {
        guiInjected = false;
        state.set({ running: false });
        const r = await api(port, '/api/task/start', { method: 'POST', body: {} });
        assert.strictEqual(r.status, 409);
        assert.strictEqual((await r.json()).error, 'context not injected');
    });

    await test('C5b /api/task/start 真实调起任务启动器（非占位）', async () => {
        guiInjected = true;
        state.set({ running: false });
        const before = started.length;
        const r = await api(port, '/api/task/start', { method: 'POST', body: {} });
        assert.strictEqual(r.status, 200);
        const body = await r.json();
        assert.strictEqual(body.ok, true);
        assert.strictEqual(body.placeholder, undefined, '不再是占位实现');
        await new Promise(res => setTimeout(res, 20));
        assert.strictEqual(started.length, before + 1, '须调用 handlers.startTask');
        assert.strictEqual(started[started.length - 1].probe, false);
    });

    await test('C5c /api/task/start 并发期间第二次 → 409 busy', async () => {
        const r = await api(port, '/api/task/start', { method: 'POST', body: {} });
        assert.strictEqual(r.status, 409);
        assert.strictEqual((await r.json()).error, 'busy');
    });

    await test('C5d /api/task/stop 复位 running，可再次启动', async () => {
        let r = await api(port, '/api/task/stop', { method: 'POST', body: {} });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(state.get().running, false, 'run 结束后 running 须复位为 false');
        r = await api(port, '/api/task/start', { method: 'POST', body: {} });
        assert.strictEqual(r.status, 200);
        await api(port, '/api/task/stop', { method: 'POST', body: {} });
    });

    await test('C5e 没有课程时 /api/task/start 返回 400，不误启动', async () => {
        const backup = fs.readFileSync(TMP_CONFIG, 'utf-8');
        fs.writeFileSync(TMP_CONFIG, '# 临时清空课程\n', 'utf-8');
        try {
            guiInjected = true;
            state.set({ running: false });
            const r = await api(port, '/api/task/start', { method: 'POST', body: {} });
            assert.strictEqual(r.status, 400);
            assert.strictEqual((await r.json()).error, 'no courses');
            assert.strictEqual(state.get().running, false, '缺课程时不得进入运行态');
        } finally {
            fs.writeFileSync(TMP_CONFIG, backup, 'utf-8');
        }
    });

    await test('C5f 未运行时 /api/task/pause 返回 409', async () => {
        state.set({ running: false, paused: false });
        const r = await api(port, '/api/task/pause', { method: 'POST', body: {} });
        assert.strictEqual(r.status, 409);
        assert.strictEqual((await r.json()).error, 'not running');
    });

    await test('C5g /api/task/resume 恢复运行并复位 paused', async () => {
        state.set({ running: true, paused: true, phase: 'paused', label: '已暂停' });
        const r = await api(port, '/api/task/resume', { method: 'POST', body: {} });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(state.get().paused, false);
        state.set({ running: false, paused: false });
    });

    await test('C5h POST 缺 token → 401', async () => {
        const r = await fetch(`http://127.0.0.1:${port}/api/task/stop`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.strictEqual(r.status, 401);
    });

    await test('C5i /api/events 错 token → 401', async () => {
        assert.strictEqual(await rawGet(port, `/api/events?token=wrong-${TOKEN}`), 401);
    });

    await test('C5j Host 头校验失败 → 403', async () => {
        assert.strictEqual(await rawGet(port, '/api/health', { host: 'evil.example:1' }), 403);
    });

    console.log('\n【日志解析 C6–C7】');

    await test('C6a parseConsoleLine 返回 { tag, ts, level, text }', () => {
        assert.strictEqual(typeof sinks.parseConsoleLine, 'function',
            'core/log-sinks.js 需导出 parseConsoleLine（impl 补实现）');
        const r = sinks.parseConsoleLine('[icourse163] 12:34:56 ⚠️ 额度已用完，本场不再尝试');
        assert.strictEqual(typeof r, 'object');
        assert.strictEqual(r.tag, 'icourse163');
        assert.strictEqual(r.ts, '12:34:56');
        assert.strictEqual(r.level, 'warn');
        assert.strictEqual(typeof r.text, 'string');
    });

    await test('C6b text 剥离图标、level 取自未剥离原文', () => {
        assert.strictEqual(typeof sinks.parseConsoleLine, 'function');
        const r = sinks.parseConsoleLine('[icourse163] 12:34:56 ⚠️ 额度已用完');
        assert.strictEqual(r.level, 'warn', '级别须按含图标的原文判定');
        assert.ok(!/[\p{Extended_Pictographic}\u{FE0F}]/u.test(r.text), '展示文本不含图标');
    });

    await test('C7a classifyLevel 按 F2 写死的完整映射', () => {
        assert.strictEqual(sinks.classifyLevel('❌ 运行出错'), 'error');
        assert.strictEqual(sinks.classifyLevel('⚠️ 超时'), 'warn');
        assert.strictEqual(sinks.classifyLevel('🛑 停用'), 'warn');
        assert.strictEqual(sinks.classifyLevel('✅ 已完成并记录'), 'success');
        assert.strictEqual(sinks.classifyLevel('🏁 全部课程处理完毕'), 'success');
        assert.strictEqual(sinks.classifyLevel('普通日志'), 'info');
    });

    await test('C7b 级别取自未剥离原文（剥离后判定会改变）', () => {
        const raw = '⚠️ 额度已用完';
        assert.strictEqual(sinks.classifyLevel(raw), 'warn');
        const stripped = raw.replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, '').trim();
        assert.ok(!/⚠️/.test(stripped));
        assert.strictEqual(sinks.classifyLevel(stripped), 'info',
            '剥离图标后关键词消失，级别字段不能用剥离后的文本判定');
    });

    console.log('\n【上下文与 fail-closed C9】');

    await test('C9a ALS 未注入时 current() 回落 noopCtx（mode cli）', () => {
        assert.strictEqual(current().mode, 'cli');
    });

    await test('C9b runWithContext 注入后 current() 返回同一 ctx', async () => {
        const c = createContext({ bus: createBus() });
        await runWithContext(c, async () => {
            assert.strictEqual(current(), c);
        });
    });

    await test('C9c GUI 上下文丢失（缺 confirm）→ submitQuiz 抛错', async () => {
        const broken = { mode: 'gui' };
        await assert.rejects(() => submitQuiz(fakePage(), log, broken));
    });

    console.log('\n【成对闸门断言：impl 实测片段】');

    await test('G1 CLI noopCtx 零 intervention 事件且照常交卷', async () => {
        const b = createBus();
        const calls = [];
        assert.strictEqual(await submitQuiz(fakePage(calls), log, noopCtx), true);
        assert.ok(calls.includes('submit-click'), 'CLI 点了提交按钮');
        assert.strictEqual(b.history(0).length, 0, 'CLI 不产生 intervention 事件');
    });

    await test('G2 GUI 取消 → submitQuiz 返回 false 且不点提交', async () => {
        const b = createBus();
        const c = createContext({ bus: b });
        const calls = [];
        const p = submitQuiz(fakePage(calls), log, c);
        const evts = b.history(0).filter(e => e.type === 'intervention');
        assert.strictEqual(evts.length, 1, 'GUI 发一次 intervention');
        assert.strictEqual(evts[0].kind, 'submit');
        c.resolveConfirm(evts[0].id, '取消', false);
        assert.strictEqual(await p, false, '未确认不得交卷');
        assert.strictEqual(calls.length, 0, '未确认不点击提交按钮');
    });

    await test('G3 GUI 确认 → submitQuiz 返回 true 且点击提交', async () => {
        const b = createBus();
        const c = createContext({ bus: b });
        const calls = [];
        const p = submitQuiz(fakePage(calls), log, c);
        const evts = b.history(0).filter(e => e.type === 'intervention');
        c.resolveConfirm(evts[0].id, '确认交卷', false);
        assert.strictEqual(await p, true, '确认后交卷');
        assert.ok(calls.includes('submit-click'), '确认后点击提交按钮');
    });

    await test('G4 setSkipConfirm(true) 恒 true，只留一条 skipped 审计事件', async () => {
        const b = createBus();
        const c = createContext({ bus: b });
        c.setSkipConfirm(true);
        assert.strictEqual(await c.confirm('submit'), true, '跳过确认恒 true');
        const evts = b.history(0).filter(e => e.type === 'intervention');
        assert.strictEqual(evts.length, 1, '按定稿口径，跳过时仍留一条审计事件');
        assert.strictEqual(evts[0].skipped, true);
        assert.strictEqual(evts[0].blocking, false, '不弹窗、直接放行');
    });

    console.log('\n【参数映射 C10 / 端点 C11】');

    await test('C10a parseArgs 五开关语义不变', () => {
        const a = parseArgs(['icourse163', '--probe', '--quiz', '--no-quiz', '--limit=3']);
        assert.strictEqual(a.probe, true);
        assert.strictEqual(a.quiz, true);
        assert.strictEqual(a.noQuiz, true);
        assert.strictEqual(a.limit, 3);
    });

    await test('C10b parseArgs 映射 submit / limit', () => {
        const a = parseArgs(['--quiz', '--submit', '--limit=2']);
        assert.strictEqual(a.submit, true);
        assert.strictEqual(a.limit, 2);
    });

    await test('C10c confirm 结果不回写 opts.submit', async () => {
        const opts = parseArgs(['--quiz']);
        const c = createContext({ bus: createBus() });
        const p = c.confirm('submit');
        const evts = c.bus.history(0).filter(e => e.type === 'intervention');
        c.resolveConfirm(evts[0].id, '确认交卷', false);
        assert.strictEqual(await p, true);
        assert.strictEqual(opts.submit, false, 'confirm 结果不得写回 opts.submit，否则 CLI 演练会变真交卷');
    });

    await test('C11a /api/task/confirm 已存在 id 「取消」→ 200 且不交卷', async () => {
        guiCtx = createContext({ bus });
        const p = submitQuiz(fakePage(), log, guiCtx);
        const evts = bus.history(0).filter(e => e.type === 'intervention');
        const id = evts[evts.length - 1].id;
        const r = await api(port, '/api/task/confirm', {
            method: 'POST', body: { id, choice: '取消', noMore: false }
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual((await r.json()).ok, true);
        assert.strictEqual(await p, false, '取消应 resolve false，不交卷');
    });

    await test('C11b /api/task/confirm 未知 id → 404', async () => {
        const r = await api(port, '/api/task/confirm', {
            method: 'POST', body: { id: 999999, choice: '确认交卷', noMore: false }
        });
        assert.strictEqual(r.status, 404);
    });

    await test('C11c noMore 仅在「确认交卷」时置 skip', async () => {
        const b = createBus();
        const c = createContext({ bus: b });
        const p1 = c.confirm('submit');
        const e1 = b.history(0).filter(e => e.type === 'intervention')[0];
        c.resolveConfirm(e1.id, '取消', true);
        assert.strictEqual(await p1, false);
        assert.strictEqual(c.skipConfirm, false, '取消时 noMore 不得置 skip');

        const p2 = c.confirm('submit');
        const e2 = b.history(e1.id).filter(e => e.type === 'intervention')[0];
        c.resolveConfirm(e2.id, '确认交卷', true);
        assert.strictEqual(await p2, true);
        assert.strictEqual(c.skipConfirm, true, '确认交卷时 noMore 才置 skip');
    });

    console.log('\n【CLI 回归 R1–R8】');

    await test('R1 三层菜单退役、无参输出中文提示指向 start.bat', () => {
        const env = { ...process.env };
        ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].forEach(k => delete env[k]);
        const r = spawnSync(process.execPath, ['start.js'], {
            cwd: ROOT, encoding: 'utf8', input: '3\n', timeout: 10000, env, windowsHide: true
        });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        assert.ok(/start\.bat/.test(out), '无参应输出指向 start.bat 的中文提示');
        assert.ok(!/输入数字后按回车/.test(out), '三层数字菜单应已退役，不再进入交互菜单');
    });

    await test('R2 非 icourse163 目标不解析', () => {
        assert.strictEqual(parseArgs(['other']).target, null);
    });

    await test('R3 icourse163 目标与课程 URL 解析', () => {
        const a = parseArgs(['icourse163', 'https://www.icourse163.org/learn/XXXX-1234567?tid=8901234']);
        assert.strictEqual(a.target, 'icourse163');
        assert.ok(a.url.startsWith('https://'));
        assert.ok(a.url.includes('tid='));
    });

    await test('R4 --probe 只扫描结构', () => {
        assert.strictEqual(parseArgs(['--probe']).probe, true);
        assert.strictEqual(parseArgs([]).probe, false);
    });

    await test('R5 --limit= 解析与缺省（quiz 侧 0=全量，learn 侧 Infinity=不限）', () => {
        assert.strictEqual(parseArgs(['--limit=3']).limit, 3);
        assert.strictEqual(parseArgs(['--limit=abc']).limit, 0, '非法值回退缺省');
        assert.strictEqual(parseArgs([]).limit, 0, 'quiz 侧缺省 0 表示全量');
        // learn 侧把缺省视为 Infinity（不限）；两处各自独立解析，收敛时须分别喂值并保各自缺省。
    });

    await test('R6 --quiz 演练不提交', () => {
        const a = parseArgs(['--quiz']);
        assert.strictEqual(a.quiz, true);
        assert.strictEqual(a.submit, false, '--quiz 默认演练，不自动提交');
    });

    await test('R7 --no-quiz 跳过测验', () => {
        assert.strictEqual(parseArgs(['--no-quiz']).noQuiz, true);
    });

    await test('R8 --submit 仅作用于 --quiz 分支', () => {
        assert.strictEqual(parseArgs(['--quiz', '--submit']).submit, true);
        assert.strictEqual(parseArgs(['--submit']).submit, true);
        // 默认「一键完成」分支硬编码 submit:true，不受 --submit 控制；
        // handleInlineQuiz 直接调用 submitQuiz()，同样不看 --submit。
    });

    console.log('\n【异常契约 T4 / T5（一期 noop 口径）】');

    await test('T4 noopCtx.waitForQr 返回 detected', async () => {
        assert.deepStrictEqual(await noopCtx.waitForQr(), { resolvedBy: 'detected' });
    });

    await test('T5 noopCtx.onDegrade 不抛错', () => {
        assert.doesNotThrow(() => noopCtx.onDegrade('quota'));
    });

    console.log('\n【二期：任务接通、章节采集与异常域】');

    await test('C8 tasks 事件每条带 chapter，且标出运行项', () => {
        const events = [];
        emitTasks({ emit: (t, p) => events.push({ t, p }) }, [
            { cid: '1', type: '视频', text: '甲', learned: true, chapter: '第一章' },
            { cid: '2', type: '测验', text: '乙', learned: false, chapter: '第二章' }
        ], { courseKey: 'TEST' }, '2');
        const tasks = events.find(e => e.t === 'tasks');
        assert.ok(tasks, '须发出 tasks 事件');
        assert.ok(tasks.p.items.every(i => typeof i.chapter === 'string' && i.chapter.length > 0));
        assert.ok(tasks.p.items.some(i => i.status === 'running'), '当前任务须标为进行中');
        assert.ok(events.some(e => e.t === 'progress' && e.p.scope === 'overall'));
    });

    await test('T2 断网异常分类与可关闭提示条', () => {
        assert.strictEqual(classifyError(new Error('getaddrinfo ENOTFOUND example.com')).type, 'network');
        assert.strictEqual(classifyError(new Error('connect ECONNRESET 1.2.3.4')).type, 'network');
        const b = createBus();
        b.emit('toast', { level: 'warn', text: '网络异常，任务已中断' });
        assert.ok(b.history(0).some(e => e.type === 'toast' && e.level === 'warn'));
    });

    await test('T3 浏览器被强关分类与阻断窗口', () => {
        assert.strictEqual(classifyError(new Error('Target closed')).type, 'closed');
        assert.strictEqual(classifyError(new Error('Browser has been closed')).type, 'closed');
        const b = createBus();
        b.emit('intervention', {
            kind: 'browser-closed', blocking: true,
            choices: ['重新打开并继续', '停止任务']
        });
        const e = b.history(0).find(x => x.type === 'intervention');
        assert.strictEqual(e.blocking, true);
        assert.ok(e.choices.includes('重新打开并继续'));
    });

    await test('配置保存写入临时文件且保留注释行', async () => {
        const r = await api(port, '/api/config/icourse', {
            method: 'POST',
            body: {
                courses: [{ url: 'https://www.icourse163.org/learn/TEST-123?tid=9', courseKey: 'TEST-123', termId: '9' }],
                activeCourse: 'TEST-123'
            }
        });
        assert.strictEqual(r.status, 200);
        const text = fs.readFileSync(TMP_CONFIG, 'utf-8');
        assert.ok(text.includes('TEST-123'), '课程地址须写入配置');
        assert.ok(text.includes('# gui-contract'), '注释行须原样保留');
    });

    await test('运行方式保存后 /api/config 能读回', async () => {
        const r = await api(port, '/api/config/advanced', {
            method: 'POST',
            body: { probe: false, quiz: false, noQuiz: false, drill: true, limit: 3, playbackRate: 2 }
        });
        assert.strictEqual(r.status, 200);
        const cfg = await (await api(port, '/api/config')).json();
        assert.strictEqual(cfg.advanced.drill, true);
        assert.strictEqual(cfg.advanced.limit, 3);
    });

    await test('记录页返回真实完成统计', async () => {
        progress.mark('TEST-COURSE', 'cid-2', { type: '视频', title: '乙', status: 'done' });
        const r = await api(port, '/api/records');
        assert.strictEqual(r.status, 200);
        const b = await r.json();
        // 顺序无关：此前用例（含恢复测试）会在记录里留下 done 条目
        assert.ok(b.stats.done >= 1, '已标记的完成条目应计入');
        assert.strictEqual(typeof b.loggedIn, 'boolean');
        assert.strictEqual(typeof b.canRestore, 'boolean');
    });

    bus.closeAll();
    if (typeof srv.server.closeAllConnections === 'function') srv.server.closeAllConnections();
    await srv.close();
    require.cache[serviceModulePath].exports = realService;
    progress.useFile(REAL_PROGRESS_FILE);
    require('../core/prefs').useFile(null);
    if (fs.existsSync(TMP_CONFIG)) fs.unlinkSync(TMP_CONFIG);
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

main().then(() => {
    console.log(`\n${passed} 通过，${failed} 失败，${skipped} 二期跳过\n`);
    process.exit(failed ? 1 : 0);
}).catch(e => {
    console.error('契约测试框架异常:', e);
    if (fs.existsSync(TMP_CONFIG)) fs.unlinkSync(TMP_CONFIG);
    process.exit(1);
});
