// 答题模型通道：适配三种协议——OpenAI Chat Completions（默认，DeepSeek 官方与
// 各类网关都用它）、Anthropic Messages、Gemini generateContent。
// 配置来自「设置 → 配置模型」浮窗（LLM_* 键），Key 保存在本机 config.txt，
// 按量计费（一场答题通常几分钱），不碰用户的任何浏览器登录态。
//
// 熔断语义与免费模型一致：连续失败 3 次本场停用，别每题都白等；
// Key 无效 / 余额不足这类不会自愈的错误直接停用。新一场由 run() 入口 reset()。

const BREAK_AFTER = 3;
const TIMEOUT_MS = 60000;
const ANTHROPIC_VERSION = '2023-06-01';

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
    log(`   ⛔ 模型本场停用：${reason}`);
}

// 三种协议的请求构造与响应解析。纯函数：可脱离网络单测。
const PROTOCOLS = {
    openai: {
        buildRequest(prompt, opts) {
            const baseUrl = String(opts.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
            return {
                url: `${baseUrl}/chat/completions`,
                headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKeyOf(opts)}` },
                body: {
                    model: opts.model || 'deepseek-chat',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: opts.maxTokens || 512,
                    temperature: opts.temperature ?? 0
                },
                parse: data => data.choices?.[0]?.message?.content || ''
            };
        }
    },
    anthropic: {
        buildRequest(prompt, opts) {
            const baseUrl = String(opts.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
            return {
                url: `${baseUrl}/v1/messages`,
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': apiKeyOf(opts),
                    'anthropic-version': ANTHROPIC_VERSION
                },
                body: {
                    model: opts.model || 'claude-sonnet-4-5',
                    max_tokens: opts.maxTokens || 512,
                    temperature: opts.temperature ?? 0,
                    messages: [{ role: 'user', content: prompt }]
                },
                parse: data => (data.content || []).map(b => b.text || '').join('') 
            };
        }
    },
    gemini: {
        buildRequest(prompt, opts) {
            const baseUrl = String(opts.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
            return {
                url: `${baseUrl}/models/${opts.model || 'gemini-2.5-flash'}:generateContent?key=${apiKeyOf(opts)}`,
                headers: { 'content-type': 'application/json' },
                body: {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: opts.temperature ?? 0, maxOutputTokens: opts.maxTokens || 512 }
                },
                parse: data => (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
            };
        }
    }
};

function apiKeyOf(opts) {
    return String(opts.apiKey || '').trim();
}

// 错误分类：401/403/402（Key 无效、欠费）不会自愈，当场停用
function classifyHttpError(status) {
    if (status === 401 || status === 403) return 'API Key 无效或无权限';
    if (status === 402) return '账户余额不足';
    return null;
}

// 单次对话补全。opts 必带 apiKey；protocol/baseUrl/model/temperature 可覆盖。
async function askText(prompt, log, opts = {}) {
    const apiKey = apiKeyOf(opts);
    if (!apiKey) throw new Error('未配置模型 API Key');
    if (disabled) throw new Error('模型已熔断（本场不再尝试）');
    const adapter = PROTOCOLS[opts.protocol] || PROTOCOLS.openai;
    const req = adapter.buildRequest(prompt, opts);

    const t0 = Date.now();
    let res;
    try {
        res = await fetch(req.url, {
            method: 'POST',
            headers: req.headers,
            body: JSON.stringify(req.body),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (e) {
        consecutiveFailures++;
        if (consecutiveFailures >= BREAK_AFTER) disable(`连续 ${BREAK_AFTER} 次请求失败`, log);
        throw new Error(`请求失败: ${e.message}`);
    }

    if (!res.ok) {
        const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140);
        const fatal = classifyHttpError(res.status);
        if (fatal) disable(fatal + '（HTTP ' + res.status + '）', log);
        else {
            consecutiveFailures++;
            if (consecutiveFailures >= BREAK_AFTER) disable(`HTTP ${res.status} 连续 ${BREAK_AFTER} 次`, log);
        }
        throw new Error(`HTTP ${res.status}: ${body}`);
    }

    const data = await res.json().catch(() => ({}));
    const text = req.parse(data);
    if (!text) {
        consecutiveFailures++;
        if (consecutiveFailures >= BREAK_AFTER) disable('返回内容为空连续 3 次', log);
        throw new Error('返回内容为空');
    }

    log(`   🤖 ${req.body.model} · ${opts.protocol || 'openai'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    consecutiveFailures = 0;
    return text;
}

module.exports = { askText, isDisabled, reset, PROTOCOLS };
