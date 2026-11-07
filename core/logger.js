const COLORS = [
    '\x1b[36m',  // cyan
    '\x1b[33m',  // yellow
    '\x1b[35m',  // magenta
    '\x1b[32m',  // green
    '\x1b[91m',  // bright red
    '\x1b[96m',  // bright cyan
    '\x1b[93m',  // bright yellow
    '\x1b[95m',  // bright magenta
];
const RESET = '\x1b[0m';
const GRAY = '\x1b[90m';

// 一场跑两三个小时，没有时间戳根本看不出卡在哪一步、卡了多久
function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function createLogger(tag, colorIndex) {
    const color = COLORS[(colorIndex || 0) % COLORS.length];
    const prefix = `${color}${tag}${RESET}`;
    return (...args) => console.log(prefix, `${GRAY}${stamp()}${RESET}`, ...args);
}

module.exports = { createLogger };
