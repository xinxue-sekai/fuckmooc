const path = require('path');
const fs = require('fs');
const { num } = require('../../core/config');
// 经模块对象调用而不是解构：GUI 契约测试会替换 config-service 的导出做隔离
const configService = require('../../core/config-service');
const { parseArgs } = require('../../core/cli-options');

// 项目根目录
const ROOT = path.join(__dirname, '..', '..');

let cfg = configService.getSettings();

// 旧版 DeepSeek 键 → LLM_*：一次性迁移，旧键保留在文件里但不再读取
if (cfg.DEEPSEEK_API_KEY && !cfg.LLM_API_KEY) {
    try {
        configService.writeConfigValues({
            LLM_API_KEY: cfg.DEEPSEEK_API_KEY,
            LLM_ENABLED: cfg.DEEPSEEK_ENABLED || 'false',
            LLM_PROVIDER: 'deepseek',
            LLM_BASE_URL: 'https://api.deepseek.com',
            LLM_MODEL: 'deepseek-chat'
        }, path.join(ROOT, 'config.txt'));
        cfg = configService.getSettings();
    } catch {}
}

// 课程地址：命令行参数优先，其次配置文件，支持多个（换行或逗号分隔）
function parseCourseUrls(raw) {
    if (!raw) return [];
    return raw
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(url => {
            // 兼容 course/XXXX-1234567?tid=xxx 与 learn/XXXX-1234567?tid=xxx
            const m = url.match(/([A-Za-z]+-\d+)/);
            const t = url.match(/[?&]tid=(\d+)/);
            return {
                url: url.split('#')[0],
                courseKey: m ? m[1] : '',
                termId: t ? t[1] : ''
            };
        })
        .filter(c => c.courseKey);
}

// argv 只在 core/cli-options.js 解析；每次调用都重读配置，供 run(options) 动态取课程
function getCourses() {
    const c = configService.getSettings();
    const url = parseArgs().url || c.ICOURSE_COURSE_URL || process.env.ICOURSE_COURSE_URL;
    return parseCourseUrls(url);
}
// 登录态放在用户目录下，不跟项目走：换目录、重新解压新版本都不用重新扫码
const os = require('os');
const HOME_DIR = path.join(os.homedir(), '.fuckmooc');
const PROFILE_DIR = path.resolve(
    cfg.ICOURSE_PROFILE_DIR || process.env.ICOURSE_PROFILE_DIR || path.join(HOME_DIR, 'icourse163-profile')
);

// 老版本把登录态放在项目里，第一次运行时搬过去，省得重新登录
function migrateLegacyProfile() {
    const legacy = path.join(ROOT, 'data', 'icourse163-profile');
    if (fs.existsSync(PROFILE_DIR) || !fs.existsSync(legacy)) return false;
    fs.mkdirSync(HOME_DIR, { recursive: true });
    try {
        fs.renameSync(legacy, PROFILE_DIR);
    } catch {
        // 跨盘符没法 rename，先复制再删旧的，避免占双份空间
        fs.cpSync(legacy, PROFILE_DIR, { recursive: true, force: true });
        fs.rmSync(legacy, { recursive: true, force: true });
    }
    return true;
}

// 数据目录：日志与断点
const DATA_DIR = path.join(ROOT, 'data', 'icourse163');

// 运行参数不在 require 时固化：GUI 常驻进程里设置页保存后要下一场立即生效，
// 所以暴露成可刷新对象，run() 开始时 reloadSettings() 重读 config.txt
const settings = {
    PLAYBACK_RATE: 2,
    DOCUMENT_STAY_MS: 35000,
    OP_DELAY_MIN: 1200,
    OP_DELAY_MAX: 2600,
    QUIZ_BUDGET_MS: 25 * 60 * 1000,
    QUIZ_MAX_MISS_RATIO: 0.2,
    LLM_ENABLED: false,
    LLM_PROVIDER: 'deepseek',
    LLM_BASE_URL: '',
    LLM_API_KEY: '',
    LLM_MODEL: '',
    ACTIVE_COURSE: null
};

function reloadSettings() {
    const c = configService.getSettings();    settings.PLAYBACK_RATE = num(c.ICOURSE_PLAYBACK_RATE, 2);
    settings.DOCUMENT_STAY_MS = num(c.ICOURSE_DOCUMENT_STAY_MS, 35000);
    settings.OP_DELAY_MIN = num(c.ICOURSE_OP_DELAY_MIN, 1200);
    settings.OP_DELAY_MAX = num(c.ICOURSE_OP_DELAY_MAX, 2600);
    settings.QUIZ_BUDGET_MS = num(c.ICOURSE_QUIZ_BUDGET_MS, 25 * 60 * 1000);
    settings.QUIZ_MAX_MISS_RATIO = num(c.ICOURSE_QUIZ_MAX_MISS_RATIO, 0.2);
    settings.LLM_ENABLED = String(c.LLM_ENABLED || '').toLowerCase() === 'true';
    settings.LLM_PROVIDER = c.LLM_PROVIDER || 'deepseek';
    settings.LLM_PROTOCOL = c.LLM_PROTOCOL || 'openai';
    settings.LLM_BASE_URL = String(c.LLM_BASE_URL || '').trim();
    settings.LLM_API_KEY = String(c.LLM_API_KEY || '').trim();
    settings.LLM_MODEL = String(c.LLM_MODEL || '').trim();
    settings.ACTIVE_COURSE = String(c.ICOURSE_ACTIVE_COURSE || '').trim() || null;
    return settings;
}
reloadSettings();

function assertCourses() {
    if (getCourses().length > 0) return true;
    console.error('');
    console.error('❌ 还没有告诉我要刷哪门课。两种方式任选一种：');
    console.error('');
    console.error('   方式一：用记事本打开 config.txt，加一行（推荐）');
    console.error('           ICOURSE_COURSE_URL=https://www.icourse163.org/learn/XXXX-1234567?tid=8901234');
    console.error('');
    console.error('   方式二：运行时直接把地址跟在命令后面');
    console.error('           node start.js icourse163 "https://www.icourse163.org/learn/XXXX-1234567?tid=8901234"');
    console.error('');
    console.error('   课程地址就是打开课程后浏览器地址栏里那一整串。');
    console.error('');
    return false;
}

function ensureDirs() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (migrateLegacyProfile()) {
        console.log(`  📦 登录态已搬到 ${PROFILE_DIR}，以后不用重新扫码`);
    }
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

// 随机延迟，模拟真人节奏
function humanDelay(page) {
    const ms = settings.OP_DELAY_MIN + Math.random() * (settings.OP_DELAY_MAX - settings.OP_DELAY_MIN);
    return page.waitForTimeout(ms);
}

module.exports = {
    ROOT,
    getCourses,
    PROFILE_DIR,
    HOME_DIR,
    DATA_DIR,
    settings,
    reloadSettings,
    assertCourses,
    ensureDirs,
    humanDelay
};
