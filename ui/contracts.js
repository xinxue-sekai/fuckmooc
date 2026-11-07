// 契约单一来源：后端 core/http-server.js 是事实来源，字段变化时同步这里。
// validate() 在响应与 SSE 事件到达时做运行时校验，不符只 console.warn 降级，
// 不阻断渲染；校验是开发的护栏，不是运行时的依赖。

const FM_SCHEMAS = {
    'GET /api/health': { fields: { ok: 'bool', phase: 'string', version: 'string' } },
    'GET /api/config': {
        fields: {
            courses: 'array', activeCourse: 'string|null', advanced: 'object',
            llm: 'object', font: 'string', theme: 'string', closeAction: 'string', llmCatalog: 'object', onboarded: 'bool'
        },
        nested: {
            advanced: {
                probe: 'bool', quiz: 'bool', noQuiz: 'bool', drill: 'bool', limit: 'number',
                playbackRate: 'number', documentStayMs: 'number', quizBudgetMs: 'number', missRatio: 'number'
            },
            llm: {
                enabled: 'bool', provider: 'string', baseUrl: 'string', model: 'string',
                keySet: 'bool', keyMask: 'string'
            },
            courses: { url: 'string', courseKey: 'string', termId: 'string' }
        }
    },
    'GET /api/state': {
        fields: { phase: 'string', label: 'string', running: 'bool', paused: 'bool', windowVisible: 'bool' }
    },
    'GET /api/records': {
        fields: { stats: 'object', logCount: 'number', loggedIn: 'bool', canRestore: 'bool' },
        nested: { stats: { done: 'number', failed: 'number', total: 'number' } }
    },
    'POST /api/records/restore': { fields: { ok: 'bool', restored: 'number' } },
    'POST llm-models': { fields: { models: 'array' } },
    'POST ok': { fields: { ok: 'bool' } }
};

const FM_EVENT_SCHEMAS = {
    log: { fields: { level: 'string', tag: 'string', text: 'string', ts: 'string' } },
    toast: { fields: { text: 'string', level: 'string' } },
    state: { fields: { phase: 'string', label: 'string', running: 'bool', paused: 'bool' } },
    // progress 的字段随 scope 变化（overall/current），只做宽松校验
    progress: { fields: { scope: 'string' } },
    tasks: {
        fields: { items: 'array' },
        nested: { items: { cid: 'string', chapter: 'string', type: 'string', title: 'string', status: 'string' } }
    },
    summary: { fields: { totals: 'object' } },
    intervention: { fields: { id: 'number' } }
};

function fmTypeOk(v, t) {
    if (t === 'array') return Array.isArray(v);
    if (t === 'object') return !!v && typeof v === 'object' && !Array.isArray(v);
    if (t === 'bool') return typeof v === 'boolean';
    if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
    if (t === 'string') return typeof v === 'string';
    if (t === 'string|null') return v === null || typeof v === 'string';
    return true;
}

// name: 'GET /api/config' 等端点名，或 SSE 事件名（log/state/...）
function fmValidate(name, data) {
    const schema = FM_SCHEMAS[name] || FM_EVENT_SCHEMAS[name];
    if (!schema || !data || typeof data !== 'object') return;
    const errs = [];
    for (const [k, t] of Object.entries(schema.fields || {})) {
        if (!(k in data)) { errs.push(`缺字段 ${k}(${t})`); continue; }
        if (!fmTypeOk(data[k], t)) errs.push(`字段 ${k} 应为 ${t}，实际 ${typeof data[k]}`);
    }
    for (const [key, sub] of Object.entries(schema.nested || {})) {
        const val = data[key];
        if (val === undefined || val === null) continue;
        if (Array.isArray(val)) {
            val.forEach((row, i) => {
                for (const [k, t] of Object.entries(sub)) {
                    if (!(k in row) || !fmTypeOk(row[k], t)) errs.push(`${key}[${i}].${k} 应为 ${t}`);
                }
            });
        } else if (typeof val === 'object') {
            for (const [k, t] of Object.entries(sub)) {
                if (!(k in val) || !fmTypeOk(val[k], t)) errs.push(`${key}.${k} 应为 ${t}`);
            }
        }
    }
    if (errs.length) console.warn(`[契约] ${name} 与定义不符：\n  ${errs.join('\n  ')}`);
}
