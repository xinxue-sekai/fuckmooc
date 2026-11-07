// 数字型配置兜底：填了非法值就退回默认，避免 NaN 一路传下去导致静默失效
function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

module.exports = { num };
