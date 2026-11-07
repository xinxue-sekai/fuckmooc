// 完成记录：把每个任务点的处理结果落到磁盘，支持断点续跑和收尾查漏
//
// 结构：
// {
//   "XXXX-1234567": {
//     "updatedAt": "2026-11-04T10:30:00.000Z",
//     "tasks": {
//       "1321625658": { "type": "测验", "title": "课后测验", "status": "done", "at": "..." },
//       "1321625659": { "type": "讨论", "title": "讨论1", "status": "failed", "at": "..." }
//     }
//   }
// }

const fs = require('fs');
const path = require('path');

const DATA_DIR_DEFAULT = path.resolve(__dirname, '..', 'data', 'icourse163');
let DATA_DIR = DATA_DIR_DEFAULT;
let FILE = path.join(DATA_DIR, 'progress.json');

// 测试隔离用：把落盘位置指到临时文件，避免碰到用户的完成记录
function useFile(file) {
    FILE = file;
    DATA_DIR = path.dirname(file);
}

function readAll() {
    try {
        return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    } catch {
        return {};
    }
}

function load(courseKey) {
    const all = readAll();
    return all[courseKey] || { tasks: {} };
}

function save(courseKey, data) {
    const all = readAll();
    all[courseKey] = { ...data, updatedAt: new Date().toISOString() };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2), 'utf-8');
}

// status: done | failed —— failed 的记录下次运行会重新尝试
function mark(courseKey, cid, info) {
    const data = load(courseKey);
    data.tasks = data.tasks || {};
    data.tasks[cid] = { ...info, at: new Date().toISOString() };
    save(courseKey, data);
}

// 上次没做完的，用来在下次运行时优先处理
function pendingFromLastRun(courseKey) {
    const data = load(courseKey);
    return Object.entries(data.tasks || {})
        .filter(([, t]) => t.status !== 'done')
        .map(([cid, t]) => ({ cid, ...t }));
}

function doneCount(courseKey) {
    const data = load(courseKey);
    return Object.values(data.tasks || {}).filter(t => t.status === 'done').length;
}

function reset(courseKey) {
    const all = readAll();
    delete all[courseKey];
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2), 'utf-8');
}

// 记录页用：整体统计、日志清单与清空。progress.json 的任务结构保持不变。
function clearAll() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, '{}', 'utf-8');
}

function listLogFiles() {
    try {
        return fs.readdirSync(DATA_DIR)
            .filter(f => /^run-.*\.log$/.test(f))
            .map(f => {
                const st = fs.statSync(path.join(DATA_DIR, f));
                return { name: f, size: st.size, at: st.mtime.toISOString() };
            })
            .sort((a, b) => b.at.localeCompare(a.at));
    } catch {
        return [];
    }
}

function clearLogs() {
    for (const f of listLogFiles()) {
        try { fs.unlinkSync(path.join(DATA_DIR, f.name)); } catch {}
    }
}

// ---------- 清空可撤销：清空前改名备份（保留最近一代），恢复时改回原名 ----------

function backupProgress() {
    if (!fs.existsSync(FILE)) return;
    fs.rmSync(FILE + '.bak', { force: true });
    try { fs.renameSync(FILE, FILE + '.bak'); } catch {}
}

function backupLogs() {
    for (const f of listLogFiles()) {
        try { fs.renameSync(path.join(DATA_DIR, f.name), path.join(DATA_DIR, f.name + '.bak')); } catch {}
    }
}

function backupExists() {
    if (fs.existsSync(FILE + '.bak')) return true;
    try { return fs.readdirSync(DATA_DIR).some(f => f.endsWith('.log.bak')); } catch { return false; }
}

function restoreBackup() {
    let restored = 0;
    if (fs.existsSync(FILE + '.bak')) {
        fs.rmSync(FILE, { force: true });
        try {
            fs.renameSync(FILE + '.bak', FILE);
            restored++;
        } catch {}
    }
    try {
        for (const f of fs.readdirSync(DATA_DIR)) {
            if (f.endsWith('.log.bak')) {
                fs.renameSync(path.join(DATA_DIR, f), path.join(DATA_DIR, f.slice(0, -'.bak'.length)));
                restored++;
            }
        }
    } catch {}
    return restored;
}

module.exports = {
    load, save, mark, pendingFromLastRun, doneCount, reset,
    readAll, clearAll, listLogFiles, clearLogs, useFile, FILE,
    backupProgress, backupLogs, backupExists, restoreBackup
};
