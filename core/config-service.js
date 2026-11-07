const fs = require('fs');
const path = require('path');
const { num } = require('./config');
const { getPrefs, setPrefs, replacePrefs } = require('./prefs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config.txt');

function eolOf(text) {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

function readAll(file = DEFAULT_CONFIG) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const cfg = {};
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i <= 0) continue;
        const v = t.slice(i + 1).trim();
        if (v) cfg[t.slice(0, i).trim()] = v;
    }
    return cfg;
}

// 只替换目标行，注释与相邻配置原样保留。
// 找不到就追加一行，不重写整个文件，也不改变原有换行风格。
function writeConfigValues(patch, file = DEFAULT_CONFIG) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const eol = eolOf(text);
    const lines = text ? text.split(/\r?\n/) : [];
    const keys = Object.keys(patch);

    const next = lines.map(line => {
        const t = line.trim();
        const key = keys.find(k => t.startsWith(`${k}=`));
        return key ? `${key}=${patch[key]}` : line;
    });
    for (const key of keys) {
        if (!lines.some(l => l.trim().startsWith(`${key}=`))) next.push(`${key}=${patch[key]}`);
    }

    let out = next.join(eol);
    if (text.endsWith('\n')) out += eol;
    fs.writeFileSync(file, out, 'utf8');
}

function parseCourseUrls(raw) {
    return String(raw || '')
        .split(/[\n,]/).map(s => s.trim()).filter(Boolean)
        .map(url => {
            const k = url.match(/([A-Za-z]+-\d+)/);
            const t = url.match(/[?&]tid=(\d+)/);
            return { url, courseKey: k ? k[1] : '', termId: t ? t[1] : '' };
        })
        .filter(c => c.courseKey);
}

function getCourses(file) {
    const cfg = readAll(file);
    return {
        courses: parseCourseUrls(cfg.ICOURSE_COURSE_URL),
        activeCourse: cfg.ICOURSE_ACTIVE_COURSE || null
    };
}

function setCourses(list, file) {
    writeConfigValues({ ICOURSE_COURSE_URL: (list || []).map(c => c.url).join(',') }, file);
}

function setActiveCourse(courseKey, file) {
    writeConfigValues({ ICOURSE_ACTIVE_COURSE: courseKey || '' }, file);
}

// ---------- 运行方式（RUN_*，存 config.txt） ----------
// 与界面「设置 → 运行方式」是同一份数据。setRunMode 只写调用方给出的键
// （缺失不覆盖），局部保存不会把其他开关重置回默认。

const RUN_BOOL_KEYS = [['probe', 'RUN_PROBE'], ['quiz', 'RUN_QUIZ'], ['noQuiz', 'RUN_NO_QUIZ'], ['drill', 'RUN_DRILL']];

function getRunMode(file) {
    const cfg = readAll(file);
    return {
        probe: String(cfg.RUN_PROBE || '').toLowerCase() === 'true',
        quiz: String(cfg.RUN_QUIZ || '').toLowerCase() === 'true',
        noQuiz: String(cfg.RUN_NO_QUIZ || '').toLowerCase() === 'true',
        drill: String(cfg.RUN_DRILL || '').toLowerCase() === 'true',
        limit: num(cfg.RUN_LIMIT, 0)
    };
}

function setRunMode(patch = {}, file) {
    const out = {};
    for (const [key, runKey] of RUN_BOOL_KEYS) {
        if (patch[key] !== undefined) out[runKey] = String(!!patch[key]);
    }
    if (patch.limit !== undefined) out.RUN_LIMIT = String(Math.max(0, Math.floor(Number(patch.limit) || 0)));
    if (Object.keys(out).length) writeConfigValues(out, file);
}

// ---------- 界面状态（gui-prefs.json：onboarded / font / theme） ----------

function getUiState() {
    return getPrefs();
}

function setUiState(patch = {}) {
    return setPrefs(patch);
}

// 旧版把运行方式开关存在 gui-prefs.json；归一后迁到 config.txt。
// 只迁非默认值，不给用户配置塞默认噪音；迁完从 prefs 剔除旧键。幂等，启动时调用。
const LEGACY_RUN_KEYS = ['probe', 'quiz', 'submit', 'noQuiz', 'drill', 'limit'];

function migrateLegacyRunMode(file) {
    const prefs = getPrefs();
    if (!LEGACY_RUN_KEYS.some(k => prefs[k] !== undefined)) return false;

    const patch = {};
    if (prefs.probe) patch.RUN_PROBE = 'true';
    if (prefs.quiz) patch.RUN_QUIZ = 'true';
    if (prefs.noQuiz) patch.RUN_NO_QUIZ = 'true';
    if (prefs.drill) patch.RUN_DRILL = 'true';
    if (Number(prefs.limit) > 0) patch.RUN_LIMIT = String(Number(prefs.limit));
    if (Object.keys(patch).length) writeConfigValues(patch, file);

    const rest = { ...prefs };
    for (const k of LEGACY_RUN_KEYS) delete rest[k];
    replacePrefs(rest);   // 整体替换：合并式写入会让旧键从文件里复活
    return true;
}

function setAdvanced(patch, file) {
    writeConfigValues(patch, file);
}

// 每次调用都重读配置文件，禁止模块级缓存；GUI 常驻时设置改动下次 run 即生效。
function getSettings(file = DEFAULT_CONFIG) {
    return readAll(file);
}

module.exports = {
    DEFAULT_CONFIG, readAll, getSettings, writeConfigValues, parseCourseUrls,
    getCourses, setCourses, setActiveCourse,
    getRunMode, setRunMode, getUiState, setUiState, migrateLegacyRunMode,
    setAdvanced
};
