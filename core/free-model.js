const fs = require('fs');
const path = require('path');

// 内置免费模型通道：Kilo 公开网关的免费池，无需注册、无需任何密钥。
// 免费池的提示词可能被上游记录，仅用于题目截图这类公开内容，不要传敏感信息。
const BASE = (process.env.FREE_MODEL_BASE || 'https://api.kilo.ai/api/gateway').replace(/\/+$/, '');

// 首答：优先速度，实测 1~2 秒返回，正确率够用
const VISION_FAST = [
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'dots-studio/dots-3-note-preview:free',
    'nvidia/nemotron-3.5-super-vl:free'
];

// 重做：开推理换正确率，代价是慢
const VISION_STRONG = [
    'nvidia/nemotron-3.5-super-vl:free',
    'openrouter/free'
];

const TEXT_FAST = [
    'dots-studio/dots-3-note-preview:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
];

// 重做：开推理换正确率，代价是慢
// ultra 是池子里最大的模型，实测答中文题 1.3 秒出结果且答对，排在 openrouter 之前
const TEXT_STRONG = [
    'nvidia/nemotron-3.5-super-vl:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'openrouter/free'
];

// 单次请求超时。免费池正常 1~20 秒返回，但排队时可能拖到一分钟以上，
// 压太短会误杀，压太长会让整场测验超时，折中取 2 分钟
const TIMEOUT_MS = Number(process.env.FREE_MODEL_TIMEOUT_MS || 120000);
const MAX_RETRY = 1;

function mimeOf(file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    return 'image/png';
}

async function post(model, messages, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
    try {
        const body = {
            model,
            messages,
            temperature: 0,
            max_tokens: opts.maxTokens || 4096,
            // 免费池里不少是推理模型，思考过程会吃光 token 导致正文为空
            reasoning: { effort: opts.effort || 'none' }
        };
        const resp = await fetch(`${BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                'user-agent': 'fuckmooc'
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        const text = await resp.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(`响应不是 JSON: ${text.slice(0, 120)}`);
        }
        if (!resp.ok) {
            const msg = data?.error?.message || data?.error || text.slice(0, 150);
            throw new Error(`HTTP ${resp.status}: ${msg}`);
        }

        const msg = data.choices?.[0]?.message;
        const content = msg?.content;
        if (typeof content === 'string' && content.trim()) return content.trim();

        const reasoning = msg?.reasoning;
        if (typeof reasoning === 'string' && reasoning.trim()) return reasoning.trim();

        throw new Error('模型返回空内容');
    } finally {
        clearTimeout(timer);
    }
}

// 免费池按出口 IP 记额度，打满后所有模型一律 429。
// 一场运行里额度不会自己恢复，所以撞到一次就整场停用，别每题都白试一遍。
// 日志显示过去有 329 次额度报错，绝大多数是重复撞出来的。
let quotaDead = false;

// 新一场任务把熔断复位：额度按时间恢复，上次 run 撞墙不代表这次也不行；
// 真还挂着的话当场第一题就会重新熔断
function resetQuota() {
    quotaDead = false;
}

function isQuotaError(e) {
    return /429|usage limit|rate limit|quota/i.test(e.message || '');
}

// 依次尝试候选模型，任一成功即返回
async function withFallback(models, messages, log, opts) {
    if (quotaDead) {
        throw new Error('免费模型额度已耗尽（本场不再尝试）');
    }

    let lastErr;
    for (const model of models) {
        for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
            try {
                const t0 = Date.now();
                const content = await post(model, messages, { ...opts, effort: opts.effortFor(model) });
                log(`   🤖 ${model} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
                return content;
            } catch (e) {
                lastErr = e;
                if (isQuotaError(e)) {
                    if (!quotaDead) {
                        log('   ⚠️ 免费模型额度已用完，本场不再尝试；可稍后重试或启用 DeepSeek');
                    }
                    quotaDead = true;
                    throw e;
                }
                log(`   ⚠️ ${model} 失败: ${e.message}`);
                if (attempt < MAX_RETRY) await new Promise(r => setTimeout(r, 1500));
            }
        }
    }
    throw lastErr || new Error('所有免费模型均不可用');
}

// strong 档开推理，其余关掉换速度
function makeOpts(tier, maxTokens) {
    const isStrong = tier === 'strong';
    return {
        maxTokens,
        effortFor: () => (isStrong ? 'medium' : 'none')
    };
}

async function askText(prompt, log = console.log, tier = 'fast') {
    const models = tier === 'strong' ? TEXT_STRONG : TEXT_FAST;
    return withFallback(models, [{ role: 'user', content: prompt }], log, makeOpts(tier));
}

async function askImage(imagePath, prompt, log = console.log, tier = 'fast') {
    const abs = path.resolve(imagePath);
    let b64;
    try {
        b64 = fs.readFileSync(abs).toString('base64');
    } catch (e) {
        throw new Error(`读取图片失败: ${e.message}`);
    }
    const models = tier === 'strong' ? VISION_STRONG : VISION_FAST;
    const messages = [{
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeOf(abs)};base64,${b64}` } }
        ]
    }];
    return withFallback(models, messages, log, makeOpts(tier));
}

// 从模型输出里抠出 JSON 对象
function extractJson(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        return JSON.parse(m[0]);
    } catch {
        return null;
    }
}

module.exports = { askText, askImage, extractJson, resetQuota };
