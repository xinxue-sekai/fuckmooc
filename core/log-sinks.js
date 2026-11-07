// 把业务层 console 输出转成结构化 log 事件，供界面订阅。
// 级别取自未剥离原文；剥离图标与 ANSI 只作用于展示文本。
const ICON = /[\p{Extended_Pictographic}\u{FE0F}]/gu;
const ANSI = /\x1b\[[0-9;]*m/g;

function classifyLevel(text) {
    if (/❌|出错/.test(text)) return 'error';
    if (/⚠️|🛑|超时|停用|跳过/.test(text)) return 'warn';
    if (/✅|🏁|已完成|成功/.test(text)) return 'success';
    return 'info';
}

// 从一行 console 输出解析出 { tag, ts, level, text }。
// tag 取 [xxx] 前缀、ts 取 HH:MM:SS；level 取自未剥离原文；text 剥离 emoji 与 ANSI 并压缩空白。
function parseConsoleLine(line) {
    const raw = String(line == null ? '' : line);
    const plain = raw.replace(ANSI, '');
    const tagMatch = plain.match(/\[([^\]]+)\]/);
    const tsMatch = plain.match(/\b(\d{2}:\d{2}:\d{2})\b/);
    let text = plain;
    if (tagMatch) text = text.replace(tagMatch[0], ' ');
    if (tsMatch) text = text.replace(tsMatch[0], ' ');
    text = text.replace(ICON, '').replace(/\s+/g, ' ').trim();
    return {
        tag: tagMatch ? tagMatch[1] : null,
        ts: tsMatch ? tsMatch[1] : '',
        level: classifyLevel(raw),
        text
    };
}

let installed = null;

function installSinks(bus) {
    if (installed) return;
    const origLog = console.log;
    const origErr = console.error;
    const push = (args) => {
        const raw = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
        try {
            const parsed = parseConsoleLine(raw);
            bus.emit('log', { level: parsed.level, tag: parsed.tag || '任务', text: parsed.text });
        } catch {}
    };
    console.log = (...a) => { origLog(...a); push(a); };
    console.error = (...a) => { origErr(...a); push(a); };
    installed = { origLog, origErr };
}

function restore() {
    if (!installed) return;
    console.log = installed.origLog;
    console.error = installed.origErr;
    installed = null;
}

module.exports = { installSinks, restore, classifyLevel, parseConsoleLine };
