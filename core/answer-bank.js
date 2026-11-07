// 题库检索：把题干拿去公开题库里搜标准答案
//
// 两个必须处理的问题：
// 1. 题库是模糊搜索，会返回不相关的题，必须做相似度校验，否则张冠李戴
// 2. 同一道题在不同题库里选项顺序不同，答案字母不能直接用，必须按选项内容映射

const ENDPOINT = 'https://www.hive-net.cn/backend/course/search';
const TOKEN = process.env.ANSWER_BANK_TOKEN || 'free';
const TIMEOUT_MS = Number(process.env.ANSWER_BANK_TIMEOUT_MS || 15000);

// 题干相似度低于这个值就认为没命中，宁可交给模型也不瞎填。
// 阈值定得偏严是故意的：「我国的国体是」和「我国的政体是」相似度就有 0.83，
// 一字之差就是两道完全不同的题，答错比不答代价更高
const MATCH_THRESHOLD = Number(process.env.ANSWER_BANK_THRESHOLD || 0.9);

function normalize(text) {
    return String(text || '')
        .replace(/[\s\u3000]/g, '')
        .replace(/[（）()【】\[\]《》<>。，,、；;：:！!？?"'“”‘’·.\-—_]/g, '')
        .toLowerCase();
}

// 题库偶尔会整段时间不可用（IP 被限、服务维护、返回验证页）。
// 连续失败几次后本轮就不再尝试，免得每题都白等一次超时，日志也被刷屏
const MAX_FAILURES = 3;
let consecutiveFailures = 0;

function resetHealth() {
    consecutiveFailures = 0;
}

// 最长公共子序列占比，衡量两段文字的相似程度
function similarity(a, b) {
    const s1 = normalize(a);
    const s2 = normalize(b);
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1;

    const n = s1.length;
    const m = s2.length;
    let prev = new Array(m + 1).fill(0);
    let cur = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            cur[j] = s1[i - 1] === s2[j - 1]
                ? prev[j - 1] + 1
                : Math.max(prev[j], cur[j - 1]);
        }
        [prev, cur] = [cur, prev];
        cur.fill(0);
    }
    const lcs = prev[m];
    return (2 * lcs) / (n + m);
}

// 解析题库返回的选项串，形如 "A.xxx,B.yyy" 或 "A:xxx,B:yyy"
function parseBankOptions(raw) {
    const out = {};
    if (!raw) return out;
    for (const part of String(raw).split(/[,，]/)) {
        const m = part.trim().match(/^([A-Za-z])[.．。:：]\s*(.+)$/);
        if (m) out[m[1].toUpperCase()] = m[2].trim();
    }
    return out;
}

// options: [{ key: 'A', text: '富强、民主...' }, ...]
// 返回命中的选项 key 数组，或 null 表示没有可用结果
function mapAnswer(bankItem, currentOptions) {
    const bankOpts = parseBankOptions(bankItem.answer_options);
    const letters = String(bankItem.answer || '')
        .split(/[,，\s]+/)
        .map(s => s.trim().toUpperCase())
        .filter(Boolean);

    // 题库没给选项内容时，只能用字母硬匹配（风险较高，要求题面几乎一致）
    if (Object.keys(bankOpts).length === 0) {
        return letters.filter(l => currentOptions.some(o => o.key === l));
    }

    const answerTexts = letters.map(l => bankOpts[l]).filter(Boolean);
    if (answerTexts.length === 0) return null;

    const picked = [];
    for (const text of answerTexts) {
        let bestKey = null;
        let bestScore = 0;
        for (const opt of currentOptions) {
            const score = similarity(text, opt.text);
            if (score > bestScore) {
                bestScore = score;
                bestKey = opt.key;
            }
        }
        // 选项文字对不上说明题面虽然像但不是同一道题
        if (bestKey && bestScore >= 0.8) picked.push(bestKey);
    }

    return picked.length === answerTexts.length ? picked : null;
}

async function searchInBank(question, options, log = console.log) {
    if (!question || normalize(question).length < 6) return null;

    // 已经连挂好几次了，本轮直接走搜索，别再撞
    if (consecutiveFailures >= MAX_FAILURES) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let list = [];
    try {
        const url = `${ENDPOINT}?token=${encodeURIComponent(TOKEN)}&question=${encodeURIComponent(question)}`;
        const resp = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'fuckmooc' } });
        const text = await resp.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            consecutiveFailures++;
            log(`   ⚠️ 题库返回非 JSON（第 ${consecutiveFailures} 次，连续 ${MAX_FAILURES} 次后本轮跳过）`);
            return null;
        }
        if (data.code !== 0) {
            consecutiveFailures++;
            log(`   ⚠️ 题库返回 code=${data.code}（第 ${consecutiveFailures} 次）`);
            return null;
        }
        consecutiveFailures = 0;
        list = data?.data?.list || [];
    } catch (e) {
        consecutiveFailures++;
        log(`   ⚠️ 题库请求失败: ${e.message}（第 ${consecutiveFailures} 次）`);
        return null;
    } finally {
        clearTimeout(timer);
    }

    if (list.length === 0) return null;

    let best = null;
    for (const item of list) {
        const score = similarity(question, item.question);
        if (!best || score > best.score) best = { item, score };
    }

    if (!best || best.score < MATCH_THRESHOLD) {
        log(`   🔍 题库最相似只有 ${(best ? best.score : 0).toFixed(2)}，不采用`);
        return null;
    }

    // 题干长度差太多，即使相似度高也可能不是同一道题
    const lenA = normalize(question).length;
    const lenB = normalize(best.item.question).length;
    if (Math.min(lenA, lenB) / Math.max(lenA, lenB) < 0.7) {
        log('   🔍 题库命中但题干长度差异过大，不采用');
        return null;
    }

    const keys = mapAnswer(best.item, options);
    if (!keys || keys.length === 0) {
        log(`   🔍 题库命中但选项对不上（相似度 ${best.score.toFixed(2)}）`);
        return null;
    }

    log(`   📚 题库命中（相似度 ${best.score.toFixed(2)}）答案: ${keys.join(',')}`);
    return { keys, score: best.score, matchedQuestion: best.item.question };
}

module.exports = { searchInBank, similarity, normalize, parseBankOptions, mapAnswer, resetHealth, MATCH_THRESHOLD };
