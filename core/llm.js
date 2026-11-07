// 答题模型通道：任意 OpenAI 兼容接口（官方 DeepSeek、网关或自部署）。
// 配置来自「设置 → 配置模型」浮窗（LLM_* 键），Key 保存在本机 config.txt，
// 按量计费（一场答题通常几分钱），不碰用户的任何浏览器登录态。
//
// 熔断语义与免费模型一致：连续失败 3 次本场停用，别每题都白等；
// Key 无效 / 余额不足这类不会自愈的错误直接停用。新一场由 run() 入口 reset()。

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const BREAK_AFTER = 3;
const TIMEOUT_MS = 60000;

let consecutiveFailures = 0;
let disabled = false;

function isDisabled() {
    return disabled;
}

function reset() {
    consecutiveFailures = 0;
    disabled = false;
}

function disable(reason, log) {
    disabled = true;
    log(`   ⛔ DeepSeek 本场停用：${reason}`);
}

// 单次对话补全。opts 必带 apiKey；baseUrl/model/temperature 可覆盖。
async function askText(prompt, log, opts = {}) {
    const apiKey = String(opts.apiKey || '').trim();
    if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY');
    if (disabled) throw new Error('DeepSeek 已熔断（本场不再尝试）');

    const t0 = Date.now();
    let res;
    try {
        res = await fetch(`${opts.baseUrl || DEFAULT_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: opts.model || DEFAULT_MODEL,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: opts.maxTokens || 512,
                temperature: opts.temperature ?? 0
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (e) {
        consecutiveFailures++;
        if (consecutiveFailures >= BREAK_AFTER) disable(`连续 ${BREAK_AFTER} 次请求失败`, log);
        throw new Error(`请求失败: ${e.message}`);
    }

    if (!res.ok) {
        const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140);
        // Key 无效、账户欠费都不会自己好，当场停用；限流等其他错误按连续失败计
        if (res.status === 401 || res.status === 403) disable('API Key 无效或无权限（HTTP ' + res.status + '）', log);
        else if (res.status === 402) disable('账户余额不足（HTTP 402）', log);
        else {
            consecutiveFailures++;
            if (consecutiveFailures >= BREAK_AFTER) disable(`HTTP ${res.status} 连续 ${BREAK_AFTER} 次`, log);
        }
        throw new Error(`HTTP ${res.status}: ${body}`);
    }

    const data = await res.json().catch(() => ({}));
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) {
        consecutiveFailures++;
        if (consecutiveFailures >= BREAK_AFTER) disable('返回内容为空连续 3 次', log);
        throw new Error('返回内容为空');
    }

    log(`   🤖 deepseek (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    consecutiveFailures = 0;
    return text;
}

module.exports = { askText, isDisabled, reset };
