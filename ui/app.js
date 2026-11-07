const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const ICON = /[\p{Extended_Pictographic}\u{FE0F}]/gu;
const strip = s => String(s || '').replace(ICON, '').replace(/\s+/g, ' ').trim();
// 业务文本可能带 HTML 片段（题干里就有），拼进 innerHTML 前必须转义
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
// 数值输入的统一兜底：Number.isFinite 才采用，0 是合法值不再被默认值吞掉
const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

const PHASE_TEXT = {
    idle: '待命', 'env-check': '环境检查', login: '检查登录', learn: '学习中',
    quiz: '答题中', summary: '汇总', done: '已完成', stopped: '已停止',
    paused: '已暂停', running: '运行中'
};

const ui = {
    logs: [], filter: 'all', search: '', scrollPaused: false, pending: 0,
    config: null, courses: [], activeCourse: null,
    running: false, dialogId: null
};

// 未保存修改：离开页面前提醒（切页 + 关窗两道拦截）
const dirty = { courses: false, settings: false };
const clearDirty = page => { dirty[page] = false; };
const anyDirty = () => dirty.courses || dirty.settings;

function toast(text, level = 'info', action = null) {
    const el = document.createElement('div');
    el.className = `toast ${level}`;
    const span = document.createElement('span');
    span.textContent = strip(text);
    el.appendChild(span);
    if (action) {
        const btn = document.createElement('button');
        btn.className = 'toast-action';
        btn.textContent = action.label;
        btn.onclick = async () => { el.remove(); await action.run(); };
        el.appendChild(btn);
    }
    $('#toasts').appendChild(el);
    // 带操作的 toast 停留更久，给用户反应时间
    setTimeout(() => el.remove(), action ? 10000 : 6000);
}

// 字段级即时校验：错误就地显示在输入框下方，不清空用户已填内容
function setFieldError(input, msg) {
    const row = input.closest('.form-row') || input.parentElement;
    if (!row) return;
    let el = row.parentElement.querySelector('.field-error[data-for="' + input.id + '"]');
    if (!msg) { if (el) el.remove(); return; }
    if (!el) {
        el = document.createElement('p');
        el.className = 'field-error';
        el.dataset.for = input.id;
        row.insertAdjacentElement('afterend', el);
    }
    el.textContent = strip(msg);
}

// 课程地址：一次校验，添加与向导共用
function validateCourseUrl(raw) {
    const m = String(raw || '').trim().match(/https?:\/\/[^\s#]+/);
    if (!m) return { ok: false, msg: '这不像一个网址，请把地址栏整串复制过来' };
    const k = m[0].match(/([A-Za-z]+-\d+)/);
    if (!k) return { ok: false, msg: '没认出课程编号，确认打开的是课程页面再复制' };
    return { ok: true, url: m[0], courseKey: k[1], termId: (m[0].match(/[?&]tid=(\d+)/) || [])[1] || '' };
}

function unlockUI() {
    document.querySelectorAll('.main, .nav').forEach(el => { el.style.pointerEvents = ''; });
}

function setStatus(patch) {
    if (patch.label !== undefined) $('#status-label').textContent = patch.label;
    if (patch.phase !== undefined) $('#status-phase').textContent = PHASE_TEXT[patch.phase] || patch.phase;
    $('#status-dot').className = 'dot' + (patch.running ? ' busy' : '');
    if (patch.running !== undefined) {
        ui.running = patch.running;
        $('#btn-start').disabled = patch.running;
        $('#btn-pause').disabled = !patch.running;
        $('#btn-stop').disabled = !patch.running;
        $('#btn-pause').textContent = patch.paused ? '继续' : '暂停';
    }
}

// 任务运行态不靠 SSE 单一来源：页面刷新后从 /api/state 恢复
async function syncState() {
    const r = await fmQuery('state', '/api/state');
    if (r.ok) { setStatus(r.data); renderGate(r.data.phase); }
}

function setProgress(p) {
    const scope = p.scope || 'overall';
    const cur = numOr(p.current, 0);
    const total = numOr(p.total, 0);
    const pct = total > 0 ? Math.min(100, Math.round(cur / total * 100)) : (numOr(p.percent, 0));
    if (scope === 'overall') {
        $('#progress-card').hidden = false;
        $('#summary-card').hidden = true;
        $('#overall-text').textContent = `${cur} / ${total} · ${pct}%`;
        $('#overall-bar').style.transform = `scaleX(${pct / 100})`;
    } else {
        $('#current-label').textContent = strip(p.label || '当前任务');
        $('#current-text').textContent = strip(p.detail || `${pct}%`);
        $('#current-bar').style.transform = `scaleX(${pct / 100})`;
    }
}

const TAG_TEXT = { done: '完成', running: '进行中', pending: '待处理', failed: '失败' };

function renderTasks(items) {
    const groups = new Map();
    for (const it of items) {
        const ch = it.chapter || '未分章';
        if (!groups.has(ch)) groups.set(ch, []);
        groups.get(ch).push(it);
    }
    const box = $('#task-list');
    box.innerHTML = '';
    const runningChapter = [...groups.entries()].find(([, list]) => list.some(i => i.status === 'running'))?.[0];

    for (const [name, list] of groups) {
        const done = list.filter(i => i.status === 'done').length;
        const wrap = document.createElement('div');
        wrap.className = 'chapter' + (name === runningChapter || groups.size === 1 ? ' open' : '');
        const head = document.createElement('div');
        head.className = 'chapter-head';
        head.innerHTML = `<span title="${esc(strip(name))}">${esc(strip(name))}</span><span class="count">${done} / ${list.length} 完成</span>`;
        head.onclick = () => wrap.classList.toggle('open');
        const body = document.createElement('div');
        body.className = 'chapter-body';
        for (const it of list) {
            const row = document.createElement('div');
            row.className = 'task-row';
            const s = it.status || 'pending';
            const title = strip(it.title || it.type || '');
            row.innerHTML = `<span title="${esc(title)}">${esc(title)}</span><span class="tag ${esc(s)}">${TAG_TEXT[s] || esc(s)}</span>`;
            body.appendChild(row);
        }
        wrap.append(head, body);
        box.appendChild(wrap);
    }
    $('#task-count').textContent = `${groups.size} 个章节 · ${items.length} 项`;
}

function renderSummary(s) {
    $('#progress-card').hidden = true;
    $('#summary-card').hidden = false;
    const totals = s.totals || {};
    const cells = [
        ['本轮完成任务', totals.tasksDone ?? 0],
        ['待处理任务', totals.tasksFailed ?? 0],
        ['已交测验', totals.quizzesSubmitted ?? 0],
        ['累计得分', totals.score ?? 0]
    ];
    $('#summary-grid').innerHTML = cells.map(([k, v]) =>
        `<div><span class="muted">${k}</span><b>${v}</b></div>`).join('');
}

// SSE 的 ts 是 UTC ISO 串，日志里显示本地时分秒
function fmtLocalTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

function addLog(evt) {
    const line = {
        level: evt.level || 'info',
        tag: strip(evt.tag || '系统'),
        ts: fmtLocalTime(evt.ts),
        text: strip(evt.text || '')
    };
    ui.logs.push(line);
    if (ui.logs.length > 800) ui.logs.shift();
    if (ui.scrollPaused) { ui.pending++; $('#pending-badge').textContent = `+${ui.pending}`; return; }
    schedulePaint();
}

// 日志刷得快时合并到下一帧，避免每条都全量重绘把界面拖卡
let paintQueued = false;
function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; paintLogs(); });
}

function paintLogs() {
    const body = $('#log-body');
    const show = ui.logs.filter(l =>
        (ui.filter === 'all' || l.level === ui.filter) &&
        (!ui.search || l.text.includes(ui.search) || l.tag.includes(ui.search))
    );
    body.innerHTML = show.map(l =>
        `<div class="log-line ${esc(l.level)}" title="${esc(l.text)}"><span class="ts">${esc(l.ts)}</span><span class="tag">${esc(l.tag)}</span><span class="text">${esc(l.text)}</span></div>`
    ).join('');
    // 跟随模式才自动滚底；用户上滚查阅时停在他所在的位置
    if (!ui.scrollPaused) body.scrollTop = body.scrollHeight;
}

function resumeFollow() {
    ui.scrollPaused = false;
    ui.pending = 0;
    $('#pending-badge').textContent = '';
    $('#btn-newest').hidden = true;
    paintLogs();
}

function showDialog(evt) {
    ui.dialogId = evt.id;
    const kind = evt.kind || 'submit';
    const d = $('#dialog');
    const nomore = kind === 'submit'
        ? '<label class="muted" style="display:block;margin-top:10px"><input type="checkbox" id="dlg-nomore"> 本场不再提示</label>' : '';
    const buttons = (evt.choices || ['确认交卷', '取消'])
        .map(c => `<button class="btn" data-choice="${esc(c)}">${esc(strip(c))}</button>`).join('');

    d.innerHTML = `<h3>${esc(strip(evt.title || '需要你操作一下'))}</h3>
        <p>${esc(strip(evt.message || ''))}</p>
        <p class="muted" id="dlg-timer"></p>
        <div class="actions">${buttons}</div>${nomore}`;
    $('#overlay').hidden = false;
    if (evt.blocking) document.querySelectorAll('.main, .nav').forEach(el => { el.style.pointerEvents = 'none'; });

    $$('#dialog [data-choice]').forEach(b => b.onclick = async () => {
        const choice = b.dataset.choice;
        const noMore = !!($('#dlg-nomore') && $('#dlg-nomore').checked);
        $('#overlay').hidden = true;
        unlockUI();
        if (kind === 'browser-closed') {
            if (choice === '重新打开并继续') await fmRequest('POST ok', '/api/task/start', { method: 'POST' });
            else await fmRequest('POST ok', '/api/task/stop', { method: 'POST', body: {} });
        } else {
            await fmRequest('POST ok', '/api/task/confirm', { method: 'POST', body: { id: ui.dialogId, choice, noMore } });
        }
    });

    if (evt.countdown) {
        let left = Number(evt.countdown) || 0;
        const tick = () => {
            if ($('#overlay').hidden) return;
            const m = Math.floor(left / 60), s = left % 60;
            $('#dlg-timer').textContent = `剩余 ${m}:${String(s).padStart(2, '0')}`;
            if (left-- <= 0) { $('#dlg-timer').textContent = '等待超时，请重新打开浏览器继续'; return; }
            setTimeout(tick, 1000);
        };
        tick();
    }
}

// 本地确认框（区分于业务 intervention）：Esc 可关闭
function confirmAction(text, onOk) {
    ui.dialogId = null;   // 本地确认没有业务确认单，Esc 允许关闭
    const d = $('#dialog');
    d.innerHTML = `<h3>确认操作</h3><p>${esc(strip(text))}</p>
        <div class="actions"><button class="btn" id="dlg-cancel">取消</button>
        <button class="btn primary" id="dlg-ok">确认</button></div>`;
    $('#overlay').hidden = false;
    $('#dlg-cancel').onclick = () => { $('#overlay').hidden = true; unlockUI(); };
    $('#dlg-ok').onclick = async () => { $('#overlay').hidden = true; unlockUI(); await onOk(); };
}

function handle(type, evt) {
    if (typeof fmValidate === 'function') fmValidate(type, evt);
    if (type === 'log') { addLog(evt); paintInstallLog(); }
    else if (type === 'state') { setStatus(evt); renderGate(evt.phase); }
    else if (type === 'progress') setProgress(evt);
    else if (type === 'tasks') renderTasks(evt.items || []);
    else if (type === 'summary') renderSummary(evt);
    else if (type === 'toast') toast(evt.text, evt.level);
    else if (type === 'intervention' && !evt.skipped) showDialog(evt);
}

function currentPage() {
    const p = $$('.page.active')[0];
    return p ? p.id.replace('page-', '') : 'home';
}

function switchPage(name) {
    const cur = currentPage();
    if (cur !== name && dirty[cur]) {
        confirmAction('当前页有未保存的修改，离开将丢失。', () => { clearDirty(cur); switchPage(name); });
        return;
    }
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
    $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
    if (name === 'records') loadRecords();
}

function renderCourses() {
    const box = $('#course-list');
    box.innerHTML = '';
    if (!ui.courses.length) {
        box.innerHTML = '<p class="muted">还没有课程地址。</p>';
    } else {
        ui.courses.forEach((c, i) => {
            const row = document.createElement('div');
            row.className = 'form-row';
            const isActive = c.courseKey === ui.activeCourse || (!ui.activeCourse && i === 0);
            row.innerHTML = `<input class="search" style="flex:1" id="course-url-${i}" value="${esc(c.url)}" data-url="${i}">
                <button class="btn small" data-active="${i}">${isActive ? '当前' : '设为当前'}</button>
                <button class="btn small" data-del="${i}">删除</button>`;
            box.appendChild(row);
        });
        $$('#course-list [data-del]').forEach(b => b.onclick = () => {
            ui.courses.splice(Number(b.dataset.del), 1);
            dirty.courses = true;
            renderCourses();
        });
        $$('#course-list [data-active]').forEach(b => b.onclick = () => {
            const c = ui.courses[Number(b.dataset.active)];
            ui.activeCourse = c.courseKey;
            dirty.courses = true;
            renderCourses();
        });
        $$('#course-list [data-url]').forEach(inp => inp.onchange = () => {
            const v = validateCourseUrl(inp.value);
            if (!v.ok) { setFieldError(inp, v.msg); return; }
            setFieldError(inp, '');
            ui.courses[Number(inp.dataset.url)] = { url: v.url, courseKey: v.courseKey, termId: v.termId };
            dirty.courses = true;
        });
    }
    $('#empty-course').hidden = ui.courses.length > 0;
    const label = ui.courses.length
        ? strip(ui.activeCourse || ui.courses[0].courseKey || '课程')
        : '尚未选择课程';
    const el = $('#status-course');
    el.textContent = label;
    el.title = label + '（点击管理课程）';
    el.style.cursor = 'pointer';
}

function fillSettings(a, cfg) {
    $('#opt-probe').checked = !!a.probe;
    $('#opt-quiz').checked = !!a.quiz;
    $('#opt-noQuiz').checked = !!a.noQuiz;
    $('#opt-drill').checked = !!a.drill;
    $('#opt-limit').value = a.limit || 0;
    $('#opt-rate').value = a.playbackRate ?? 2;
    $('#opt-stay').value = Math.round((a.documentStayMs ?? 35000) / 1000);
    $('#opt-budget').value = Math.round((a.quizBudgetMs ?? 1500000) / 60000);
    $('#opt-miss').value = a.missRatio ?? 0.2;
    $$('[data-close-action]').forEach(b =>
        b.classList.toggle('active', b.dataset.closeAction === (cfg.closeAction || 'ask')));
    $$('[data-browser-mode]').forEach(b =>
        b.classList.toggle('active', b.dataset.browserMode === (cfg.courseBrowserMode || 'minimized')));
    renderLlmSummary(cfg.llm || {});
}

function renderLlmSummary(llm) {
    const el = $('#llm-summary');
    if (llm.enabled && llm.model) { el.textContent = `${llm.provider === 'deepseek' ? 'DeepSeek' : '自定义'} · ${llm.model}（启用）`; return; }
    if (llm.enabled) { el.textContent = '已启用，但模型未配好（未生效）'; return; }
    if (llm.keySet) { el.textContent = '已保存 Key，未启用'; return; }
    el.textContent = '未配置（用免费三层答题）';
}

async function loadConfig() {
    const r = await fmQuery('config', '/api/config');
    if (!r.ok) throw new Error(r.code || '加载失败');
    const data = r.data;
    ui.config = data;
    ui.courses = (data.courses || []).map(c => ({ ...c }));
    ui.activeCourse = data.activeCourse;
    renderCourses();
    fillSettings(data.advanced || {}, data);
    applyTheme(data.theme || 'auto');
    applyFont(data.font || 'normal');
    $$('[data-theme-setting]').forEach(b =>
        b.classList.toggle('active', b.dataset.themeSetting === (data.theme || 'auto')));
}

// ---------- 外观：主题与字号（存 gui-prefs.json，经现有 prefs 接口） ----------

function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#16181c' : '#f4f5f7';
}

function applyFont(f) {
    document.documentElement.dataset.font = f === 'large' ? 'large' : 'normal';
}

async function saveUiState(patch) {
    const r = await fmRequest('POST ok', '/api/config/prefs', { method: 'POST', body: patch });
    if (r.ok && ui.config) Object.assign(ui.config, patch);
    return r;
}

// ---------- 记录页：骨架屏 / 空态 / 错误重试 / 恢复 ----------

async function loadRecords() {
    $('#record-skeleton').hidden = false;
    $('#record-stats').hidden = true;
    $('#record-error').hidden = true;
    const r = await fmQuery('records', '/api/records');
    $('#record-skeleton').hidden = true;
    if (!r.ok) {
        $('#record-stats').hidden = true;
        $('#record-error').hidden = false;
        return;
    }
    $('#record-stats').hidden = false;
    const s = r.data.stats || { done: 0, failed: 0, total: 0 };
    $('#record-stats').innerHTML = [
        ['已完成任务', s.done], ['待重试', s.failed], ['任务总数', s.total],
        ['运行日志', r.data.logCount ?? 0]
    ].map(([k, v]) => `<div><span class="muted">${k}</span><b>${v}</b></div>`).join('');
    $('#record-login').textContent = r.data.loggedIn
        ? '登录态已保存'
        : '尚未登录，首次运行需要扫码（跑一次「一键完成」会自动弹出）';
    $('#btn-restore').hidden = !r.data.canRestore;
}

function advancedPayload() {
    return {
        probe: $('#opt-probe').checked,
        quiz: $('#opt-quiz').checked,
        noQuiz: $('#opt-noQuiz').checked,
        drill: $('#opt-drill').checked,
        limit: numOr($('#opt-limit').value, 0),
        playbackRate: numOr($('#opt-rate').value, 2),
        documentStayMs: numOr($('#opt-stay').value, 35) * 1000,
        quizBudgetMs: numOr($('#opt-budget').value, 25) * 60000,
        missRatio: Math.min(1, Math.max(0, numOr($('#opt-miss').value, 0.2)))
    };
}

// 保存类按钮的统一防双击：进行中禁用，结束恢复
async function withBusy(btn, fn) {
    btn.disabled = true;
    try { return await fn(); } finally { btn.disabled = false; }
}

function bind() {
    $$('.nav-item').forEach(b => b.onclick = () => switchPage(b.dataset.page));
    $('#btn-goto-courses').onclick = () => switchPage('courses');
    // 「只做测验」和「跳过测验」互相矛盾，勾一个自动取消另一个
    $('#opt-quiz').onchange = e => { if (e.target.checked) $('#opt-noQuiz').checked = false; };
    $('#opt-noQuiz').onchange = e => { if (e.target.checked) $('#opt-quiz').checked = false; };
    // 设置页任何改动都标记未保存
    $('#page-settings').addEventListener('input', () => { dirty.settings = true; });
    $('#page-settings').addEventListener('change', () => { dirty.settings = true; });

    $$('[data-font]').forEach(b => b.onclick = async () => {
        applyFont(b.dataset.font);
        await saveUiState({ font: b.dataset.font });
        toast('字号已保存');
    });
    $$('[data-theme-setting]').forEach(b => b.onclick = async () => {
        applyTheme(b.dataset.themeSetting);
        $$('[data-theme-setting]').forEach(x => x.classList.toggle('active', x === b));
        await saveUiState({ theme: b.dataset.themeSetting });
    });
    $$('[data-close-action]').forEach(b => b.onclick = async () => {
        $$('[data-close-action]').forEach(x => x.classList.toggle('active', x === b));
        await saveUiState({ closeAction: b.dataset.closeAction });
    });
    $$('[data-browser-mode]').forEach(b => b.onclick = async () => {
        $$('[data-browser-mode]').forEach(x => x.classList.toggle('active', x === b));
        await saveUiState({ courseBrowserMode: b.dataset.browserMode });
    });

    $('#status-course').onclick = () => switchPage('courses');   // 顶栏课程标识：点击管理课程

    $('#btn-add-course').onclick = () => {
        const v = validateCourseUrl($('#course-input').value);
        if (!v.ok) { setFieldError($('#course-input'), v.msg); return; }
        setFieldError($('#course-input'), '');
        ui.courses.push({ url: v.url, courseKey: v.courseKey, termId: v.termId });
        $('#course-input').value = '';
        dirty.courses = true;
        renderCourses();
        toast('已加入列表，记得点「保存课程」', 'info');
    };

    $('#btn-save-courses').onclick = async () => {
        // 保存前置校验：任何一行还是无效地址就不发请求，避免「看起来保存了、其实存的是旧值」
        for (const inp of $$('#course-list [data-url]')) {
            const v = validateCourseUrl(inp.value);
            if (!v.ok) { setFieldError(inp, v.msg); toast('列表里有未修正的课程地址', 'warn'); return; }
        }
        const courses = ui.courses.filter(c => c.url);
        const r = await withBusy($('#btn-save-courses'), () =>
            fmRequest('POST ok', '/api/config/icourse', { method: 'POST', body: { courses, activeCourse: ui.activeCourse } }));
        if (r.ok) {
            setFieldError($('#course-input'), '');
            clearDirty('courses'); fmInvalidate('config'); toast('课程已保存'); await loadConfig();
        } else if (r.data && r.data.fields && r.data.fields.courses) {
            setFieldError($('#course-input'), r.data.fields.courses);
        } else {
            toast(r.code === 'unauthorized' ? '窗口连接失效，请重新打开' : '保存失败', 'error');
        }
    };

    $('#btn-save-settings').onclick = async () => {
        await withBusy($('#btn-save-settings'), () => saveAdvanced('设置已保存'));
    };

    $$('[data-clear]').forEach(b => b.onclick = () => {
        const type = b.dataset.clear;
        const labels = { progress: '完成记录', logs: '运行日志', profile: '登录态' };
        confirmAction(`确定清空${labels[type]}吗？清空后会保留一份备份，可在本页恢复。`, async () => {
            const r = await fmRequest('POST ok', '/api/records/clear', { method: 'POST', body: { confirm: true, type } });
            if (!r.ok) { toast('清空失败', 'error'); return; }
            fmInvalidate('records');
            await loadRecords();
            toast(`已清空${labels[type]}`, 'info', {
                label: '撤销',
                run: async () => {
                    const rr = await fmRequest('POST /api/records/restore', '/api/records/restore', { method: 'POST', body: { confirm: true } });
                    if (rr.ok) {
                        fmInvalidate('records', 'config');
                        await loadRecords();
                        toast('已恢复上次清空的数据');
                    } else if (rr.code === 'profile exists') {
                        toast('已有新的登录态，无法自动恢复', 'warn');
                    } else {
                        toast('恢复失败', 'warn');
                    }
                }
            });
        });
    });

    $('#btn-restore').onclick = () => {
        confirmAction('把上次清空的数据恢复回来吗？', async () => {
            const r = await fmRequest('POST /api/records/restore', '/api/records/restore', { method: 'POST', body: { confirm: true } });
            toast(r.ok ? '已恢复上次清空的数据' : r.code === 'profile exists' ? '已有新的登录态，无法自动恢复' : '恢复失败',
                r.ok ? 'info' : 'warn');
            fmInvalidate('records');
            await loadRecords();
        });
    };
    $('#btn-retry-records').onclick = () => loadRecords();
    $('#btn-desktop-shortcut').onclick = () => createDesktopShortcut();

    $('#btn-start').onclick = async () => {
        if (!ui.config?.courses?.length) {
            toast('还没有添加课程，先到「课程」页粘贴地址');
            switchPage('courses');
            return;
        }
        $('#btn-start').disabled = true;   // 按下即禁用，防双击重复提交
        const r = await fmRequest('POST ok', '/api/task/start', { method: 'POST' });
        if (r.ok) { setStatus({ running: true, phase: 'env-check', label: '环境检查' }); return; }
        $('#btn-start').disabled = ui.running;
        if (r.status === 409) toast(r.code === 'busy' ? '已经有一个任务在跑了' : '服务状态异常，请重开程序', 'warn');
        else if (r.status === 400) { toast('还没有课程地址，先到「课程」页添加', 'warn'); switchPage('courses'); }
        else if (r.status !== 0) toast('启动失败', 'error');
    };
    $('#btn-pause').onclick = async () => {
        const paused = $('#btn-pause').textContent === '继续';
        const r = await fmRequest('POST ok', paused ? '/api/task/resume' : '/api/task/pause', { method: 'POST', body: {} });
        if (!r.ok) toast(paused ? '恢复失败' : '暂停失败', 'warn');
        await syncState();
    };
    $('#btn-stop').onclick = async () => {
        const r = await fmRequest('POST ok', '/api/task/stop', { method: 'POST', body: {} });
        if (!r.ok) toast('停止失败', 'warn');
    };
    $('#btn-quit').onclick = () => fmRequest('POST ok', '/api/app/quit', { method: 'POST', body: {} });

    $$('#level-chips [data-level]').forEach(b => b.onclick = () => {
        ui.filter = b.dataset.level;
        $$('#level-chips [data-level]').forEach(x => x.classList.toggle('active', x === b));
        paintLogs();
    });
    $('#log-search').oninput = e => { ui.search = e.target.value.trim(); paintLogs(); };
    // 用户在日志区手动上滚 → 暂停跟随并亮出「回到最新」
    $('#log-body').addEventListener('scroll', () => {
        const el = $('#log-body');
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
        if (!atBottom && !ui.scrollPaused) { ui.scrollPaused = true; $('#btn-newest').hidden = false; }
        else if (atBottom && ui.scrollPaused) resumeFollow();
    });
    $('#btn-newest').onclick = resumeFollow;
    $('#btn-dock-toggle').onclick = e => {
        const d = $('#dock');
        d.classList.toggle('collapsed');
        e.target.textContent = d.classList.contains('collapsed') ? '展开' : '收起';
    };
    $('#btn-export').onclick = () => window.open(`/api/logs/export?token=${FM.token}`);   // 下载走浏览器原生流程，豁免统一请求层

    window.addEventListener('pagehide', () => {
        navigator.sendBeacon(`/api/window/closing?token=${FM.token}`, '');
    });
    // 有未保存修改时拦截关窗/刷新（浏览器原生确认框）
    window.addEventListener('beforeunload', e => {
        if (anyDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
    // Esc：关本地确认框；向导里等价「上一步」。业务确认（交卷等）必须显式选择，不提供 Esc 旁路
    window.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const ov = $('#overlay');
        if (!ov.hidden && !ui.dialogId) { ov.hidden = true; unlockUI(); return; }
        const wz = $('#wizard-overlay');
        if (!wz.hidden && wizardStep > 1) showWizardStep(wizardStep - 1);
    });

    // 关窗询问浮窗（closeAction=ask 时，关窗会重新拉起一个带 #close-ask 的窗口）
    $('#close-min').onclick = async () => {
        const remember = $('#close-remember').checked;
        await fmRequest('POST ok', '/api/app/close-decision', { method: 'POST', body: { choice: 'tray', remember } });
        $('#close-overlay').hidden = true;
        toast('已最小化到托盘，任务继续');
        window.close();   // 关掉这个询问窗口；Edge app 窗口支持脚本关闭
    };
    $('#close-exit').onclick = async () => {
        const remember = $('#close-remember').checked;
        await fmRequest('POST ok', '/api/app/close-decision', { method: 'POST', body: { choice: 'exit', remember } });
        // 服务端收到 exit 会直接关闭进程，本窗口随之结束
    };
}

async function saveAdvanced(okText) {
    // 运行方式开关缺失不覆盖已在后端保证；这里仍带全量字段，双保险
    const payload = { ...advancedPayload() };
    const r = await fmRequest('POST ok', '/api/config/advanced', { method: 'POST', body: payload });
    if (r.ok) {
        clearDirty('settings');
        fmInvalidate('config');
        toast(okText);
        await loadConfig();
    } else {
        toast(r.code === 'unauthorized' ? '窗口连接失效，请重新打开' : '保存失败', 'error');
    }
}

// ---------- 答题模型配置浮窗 ----------

const LLM_PRESETS = {
    deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    custom: { baseUrl: '', model: '' }
};
let llmProvider = 'deepseek';

function llmCatalogFor(provider) {
    return (ui.config?.llmCatalog || {})[provider] || [];
}

function saveLlmCatalog(list) {
    const cat = { ...(ui.config?.llmCatalog || {}) };
    if (list.length) cat[llmProvider] = list; else delete cat[llmProvider];
    if (ui.config) ui.config.llmCatalog = cat;
    saveUiState({ llmCatalog: cat });
    return cat;
}

function renderLlmCatalog() {
    const box = $('#llm-catalog');
    box.innerHTML = '';
    const list = llmCatalogFor(llmProvider);
    if (!list.length) {
        const p = document.createElement('p');
        p.className = 'muted small';
        p.style.textAlign = 'center';
        p.textContent = '暂无模型目录：点「获取可用模型」拉取，或直接手填模型 ID。';
        box.appendChild(p);
        return;
    }
    const current = $('#llm-model').value.trim();
    for (const id of list) {
        const row = document.createElement('div');
        row.className = 'llm-cat-row';
        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'llm-cat-name' + (id === current ? ' active' : '');
        name.textContent = id;
        name.title = '点击设为当前模型';
        name.onclick = () => {
            $('#llm-model').value = id;
            renderLlmCatalog();
        };
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'llm-cat-del';
        del.textContent = '移除';
        del.title = '从目录移除（不影响接口侧）';
        del.onclick = () => {
            saveLlmCatalog(list.filter(x => x !== id));
            renderLlmCatalog();
        };
        row.append(name, del);
        box.appendChild(row);
    }
}

function setLlmPreset(p, keepValues) {
    llmProvider = p;
    $$('#llm-presets [data-llm-preset]').forEach(x => x.classList.toggle('active', x.dataset.llmPreset === p));
    if (p === 'deepseek') $('#llm-protocol').value = 'openai';   // DeepSeek 官方走 OpenAI 兼容
    if (!keepValues) {
        $('#llm-base-url').value = LLM_PRESETS[p].baseUrl;
        $('#llm-model').value = LLM_PRESETS[p].model;
    }
}

function llmError(msg) {
    const el = $('#llm-error');
    el.textContent = msg || '';
    el.hidden = !msg;
}

function openLlmDialog() {
    const saved = ui.config?.llm || {};
    const provider = ['deepseek', 'custom'].includes(saved.provider) ? saved.provider : 'deepseek';
    llmError('');
    $('#llm-api-key').value = '';
    $('#llm-api-key').placeholder = saved.keySet
        ? `已保存（${saved.keyMask || '已隐藏'}），填新值则替换`
        : 'sk-...';
    $('#llm-enabled').checked = !!saved.enabled;
    $('#llm-protocol').value = saved.protocol || 'openai';
    if (saved.baseUrl || saved.model) {
        // 已有配置：原样回显，预设芯片按已存 provider 高亮
        $('#llm-base-url').value = saved.baseUrl || '';
        $('#llm-model').value = saved.model || '';
        setLlmPreset(provider, true);
    } else {
        setLlmPreset(provider, false);
    }
    renderLlmCatalog();
    $('#llm-overlay').hidden = false;
}

function bindLlmDialog() {
    $$('#llm-presets [data-llm-preset]').forEach(b =>
        b.onclick = () => {
            setLlmPreset(b.dataset.llmPreset, false);
            renderLlmCatalog();
        });
    $('#llm-cancel').onclick = () => { $('#llm-overlay').hidden = true; };
    $('#btn-config-llm').onclick = openLlmDialog;
    $('#wizard-open-llm').onclick = openLlmDialog;
    $('#llm-restore-model').onclick = () => {
        $('#llm-model').value = LLM_PRESETS[llmProvider].model;
        llmError('');
    };

    $('#llm-fetch-models').onclick = async () => {
        const btn = $('#llm-fetch-models');
        const baseUrl = $('#llm-base-url').value.trim();
        const apiKey = $('#llm-api-key').value.trim();
        if (!/^https?:\/\//.test(baseUrl)) { llmError('先填有效的 API 地址（http(s) 开头）'); return; }
        btn.disabled = true; btn.textContent = '获取中…';
        const r = await fmRequest('POST llm-models', '/api/llm/models', { method: 'POST', body: { baseUrl, apiKey } });
        btn.disabled = false; btn.textContent = '获取可用模型';
        if (!r.ok) { llmError(r.data?.error || '获取失败'); return; }
        llmError('');
        const list = r.data.models || [];
        if (!list.length) { llmError('端点返回了空模型列表，可直接手填模型 ID'); return; }
        saveLlmCatalog(list);
        renderLlmCatalog();
        if (!$('#llm-model').value.trim()) $('#llm-model').value = list[0];
    };

    $('#llm-save').onclick = async () => {
        const baseUrl = $('#llm-base-url').value.trim().replace(/\/+$/, '');
        const model = $('#llm-model').value.trim();
        const apiKey = $('#llm-api-key').value.trim();
        const enabled = $('#llm-enabled').checked;
        const protocol = $('#llm-protocol').value;
        if (enabled && (!/^https?:\/\//.test(baseUrl) || !model)) {
            llmError('启用时需要有效的 API 地址与模型名');
            return;
        }
        const payload = { enabled, provider: llmProvider, protocol, baseUrl, model };
        if (apiKey) payload.apiKey = apiKey;
        const r = await fmRequest('POST ok', '/api/config/llm', { method: 'POST', body: payload });
        if (!r.ok) { llmError(r.data?.error || '保存失败'); return; }
        $('#llm-overlay').hidden = true;
        fmInvalidate('config');
        await loadConfig();
        toast('答题模型已保存');
    };
}

// ---------- 首次运行配置向导 ----------

const WIZARD_STEPS = 4;
let wizardStep = 1;

function showWizardStep(n) {
    wizardStep = n;
    for (let i = 1; i <= WIZARD_STEPS; i++) {
        $(`#wizard-step-${i}`).hidden = i !== n;
        $(`#wizard-dots span:nth-child(${i})`).classList.toggle('on', i <= n);
    }
    $('#wizard-prev').hidden = n === 1;   // 向导不可跳过，但可以自由回退
    $('#wizard-next').textContent = ['', '开始配置', '下一步', '下一步', '完成'][n];
}

// 平台选择器为将来多平台预留：往 PLATFORMS 里追加即可扩展
const PLATFORMS = [{ id: 'icourse163', name: '中国大学 MOOC' }];

function renderPlatformChips(boxId) {
    const box = $(boxId);
    box.innerHTML = '';
    PLATFORMS.forEach((p, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wizard-platform' + (i === 0 ? ' active' : '');
        b.textContent = p.name;
        b.onclick = () => {
            $$(boxId + ' .wizard-platform').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
        };
        box.appendChild(b);
    });
}

function openWizard() {
    // 配置完成前主界面不出现，只留这一页纯净的引导
    document.body.classList.add('onboarding');
    renderPlatformChips('#wizard-platforms');
    showWizardStep(1);
    $('#wizard-overlay').hidden = false;
}

async function closeWizard() {
    $('#wizard-overlay').hidden = true;
    document.body.classList.remove('onboarding');
    const r = await fmRequest('POST ok', '/api/config/prefs', { method: 'POST', body: { onboarded: true } });
    if (r.ok && ui.config) ui.config.onboarded = true;
    // 首次完成顺手把带图标的快捷方式发到桌面；失败不打扰，关于页可重试
    const s = await fmRequest('POST ok', '/api/app/desktop-shortcut', { method: 'POST' });
    if (!s.ok) toast('桌面快捷方式创建失败，可在「关于」页重试', 'warn');
}

async function createDesktopShortcut() {
    const r = await fmRequest('POST ok', '/api/app/desktop-shortcut', { method: 'POST' });
    if (r.ok) toast('已在桌面创建 fuckmooc 快捷方式');
    else toast('创建失败：' + (r.data?.error || '未知原因'), 'warn');
    return r;
}

function maybeStartWizard() {
    // 向导不可跳过：未走完引导前一律进入（各步内容可不填直接下一步）
    if (['installing', 'install-error'].includes(statePhase)) return;
    if (ui.config?.onboarded) return;
    openWizard();
}

function renderWizardSummary() {
    const n = (ui.config?.courses || []).length;
    const llm = ui.config?.llm?.enabled ? '已启用' : '未配置（不影响使用）';
    $('#wizard-summary').textContent = `配置完成：已添加 ${n} 门课程；答题模型 ${llm}。`;
}

function bindWizard() {
    let lastStepAt = 0;
    const stepGuard = () => {
        const now = Date.now();
        if (now - lastStepAt < 400) return false;   // 连点保护：一次点击只走一步
        lastStepAt = now;
        return true;
    };
    $('#wizard-prev').onclick = () => {
        if (!stepGuard()) return;
        if (wizardStep > 1) showWizardStep(wizardStep - 1);
    };
    $('#wizard-next').onclick = async () => {
        if (!stepGuard()) return;
        if (wizardStep === 2) {
            const raw = $('#wizard-course-input').value.trim();
            if (raw) {
                const v = validateCourseUrl(raw);
                if (!v.ok) { setFieldError($('#wizard-course-input'), v.msg); return; }
                setFieldError($('#wizard-course-input'), '');
                const courses = [...ui.courses.filter(c => c.url !== v.url), { url: v.url, courseKey: v.courseKey, termId: v.termId }];
                const r = await fmRequest('POST ok', '/api/config/icourse', { method: 'POST', body: { courses, activeCourse: v.courseKey } });
                if (!r.ok) { toast('保存失败，稍后再试', 'error'); return; }
                await loadConfig();
                $('#wizard-course-input').value = '';
            }
            showWizardStep(3);
        } else if (wizardStep === 3) {
            renderWizardSummary();
            showWizardStep(4);
        } else if (wizardStep === 4) {
            await closeWizard();
        } else {
            showWizardStep(wizardStep + 1);
        }
    };
}

function connect() {
    const es = new EventSource(`/api/events?token=${FM.token}`);
    for (const t of ['log', 'toast', 'state', 'progress', 'tasks', 'intervention', 'summary']) {
        es.addEventListener(t, e => {
            try { handle(t, JSON.parse(e.data)); } catch {}
        });
    }
    es.onopen = () => { $('#conn-bar').hidden = true; };
    es.onerror = () => { $('#conn-bar').hidden = false; };   // EventSource 自动重连并带 Last-Event-ID
}

// ---------- 运行阶段门控：安装屏 / 向导 / 主界面 ----------

let statePhase = 'idle';
let wasInstalling = false;
let installStartedAt = null;
let installTimer = null;

function renderGate(phase) {
    statePhase = phase;
    const installing = phase === 'installing' || phase === 'install-error';
    $('#install-view').hidden = !installing;
    $('#install-error-row').hidden = phase !== 'install-error';
    document.body.classList.toggle('installing', installing);
    if (installing) {
        // 安装期间主界面与向导都不出现
        document.body.classList.add('onboarding');
        $('#wizard-overlay').hidden = true;
        if (!installTimer) {
            installStartedAt = installStartedAt || Date.now();
            installTimer = setInterval(() => {
                $('#install-elapsed').textContent = `${Math.round((Date.now() - installStartedAt) / 1000)} 秒`;
            }, 1000);
        }
        wasInstalling = true;
        paintInstallLog();
    } else if (wasInstalling) {
        wasInstalling = false;
        clearInterval(installTimer);
        installTimer = null;
        document.body.classList.remove('onboarding');
        $('#wizard-overlay').hidden = true;
        // 装完依赖回到主流程：该走向导走向导，该进主界面进主界面
        if (ui.config) maybeStartWizard();
    }
}

function paintInstallLog() {
    const view = $('#install-view');
    if (view.hidden) return;
    const el = $('#install-log');
    el.textContent = ui.logs.filter(l => l.tag === '安装').map(l => l.text).join('\n');
    el.scrollTop = el.scrollHeight;
}

function connect() {
    const es = new EventSource(`/api/events?token=${FM.token}`);
    for (const t of ['log', 'toast', 'state', 'progress', 'tasks', 'intervention', 'summary']) {
        es.addEventListener(t, e => {
            try { handle(t, JSON.parse(e.data)); } catch {}
        });
    }
    es.onopen = () => { $('#conn-bar').hidden = true; };
    es.onerror = () => { $('#conn-bar').hidden = false; };   // EventSource 自动重连并带 Last-Event-ID
}

function checkCloseAsk() {
    const ask = location.hash === '#close-ask';
    $('#close-overlay').hidden = !ask;
}

async function boot() {
    bindLlmDialog();
    renderPlatformChips('#course-platforms');   // 课程页平台选择（多平台预留）
    connect();
    try {
        const hr = await fmQuery('health', '/api/health');
        if (hr.ok) { ui.version = hr.data.version; $('#about-version').textContent = 'v' + hr.data.version; }
    } catch {}
    try {
        await loadConfig();
        $('#boot-error').hidden = true;
        await syncState();          // state 事件会触发 renderGate：安装期进安装屏，否则走向导/主界面
        checkCloseAsk();
        maybeStartWizard();
    } catch {
        $('#boot-error').hidden = false;   // R2：加载失败必须可见、可重试
    }
}

bind();
bindWizard();
$('#btn-retry-boot').onclick = boot;
window.addEventListener('hashchange', checkCloseAsk);
boot();
