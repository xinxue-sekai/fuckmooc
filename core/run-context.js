const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

// CLI 不注入上下文时，业务层拿到这个空实现：
// 汇总文本、--submit 语义、自动交卷行为全部保持原样。
const noopControl = {
    running: true,
    paused: false,
    checkpoint: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {}
};

const noopCtx = {
    mode: 'cli',
    bus: null,
    control: noopControl,
    emit() {},
    checkpoint: async () => {},
    confirm: async () => true,
    waitForQr: async () => ({ resolvedBy: 'detected' }),
    onDegrade() {},
    resolveConfirm: () => false,
    setSkipConfirm() {},
    resetSkipConfirm() {},
    skipConfirm: false,
    beginRun() {},
    endRun() {},
    dispose() {}
};

// GUI 侧上下文。ALS 上下文是进程级（保证任意请求回调都取得到、fail-closed 不误拒），
// 而 skip / pending 等状态是 run 级：beginRun 重建、endRun 失效，不跨 run 生效。
function createContext({ bus, mode = 'gui', state = null } = {}) {
    let run = { skip: false, pending: new Map() };
    const reset = () => { run = { skip: false, pending: new Map() }; };

    // control 的 running / paused 由 state 驱动；业务层在长等待点调 checkpoint()。
    const control = {
        get running() { return state ? state.get().running : true; },
        get paused() { return state ? state.get().paused : false; },
        checkpoint: async () => {
            if (!state) return;
            while (state.get().paused && state.get().running) {
                await new Promise(r => setTimeout(r, 300));
            }
            if (!state.get().running) throw new Error('STOPPED');
        },
        pause: async () => { if (state) state.set({ paused: true }); },
        resume: async () => { if (state) state.set({ paused: false }); },
        stop: async () => { if (state) state.set({ running: false, paused: false }); }
    };

    const ctx = {
        mode,
        bus,
        control,
        emit: (type, payload) => bus.emit(type, payload),
        checkpoint: () => control.checkpoint(),
        waitForQr: async () => ({ resolvedBy: 'detected' }),
        onDegrade() {},

        confirm: async (kind) => {
            if (run.skip) {
                // 跳过时仍留一条审计事件，但不弹窗、直接放行
                bus.emit('intervention', {
                    kind: kind || 'submit', skipped: true, blocking: false,
                    title: '已按「本场不再提示」自动放行', message: '', choices: []
                });
                return true;
            }
            const evt = bus.emit('intervention', {
                kind: kind || 'submit',
                title: '需要你确认交卷',
                message: '即将提交测验答案。每个测验只有 3 次机会，提交后无法撤回。',
                choices: ['确认交卷', '取消'],
                blocking: true
            });
            return new Promise(resolve => run.pending.set(evt.id, resolve));
        },

        resolveConfirm(id, choice, noMore) {
            const key = Number(id);
            const resolve = run.pending.get(key);
            if (!resolve) return false;
            run.pending.delete(key);
            const accepted = choice === '确认交卷' || choice === true;
            if (noMore && accepted) run.skip = true;
            resolve(accepted);
            return true;
        },

        setSkipConfirm(v) { run.skip = !!v; },
        resetSkipConfirm() { run.skip = false; },
        get skipConfirm() { return run.skip; },

        beginRun() { reset(); },
        endRun() { reset(); },
        dispose() { reset(); }
    };
    return ctx;
}

// 包住整条 run(options) 链，业务层任意深度 current() 可取。
function runWithContext(ctx, fn) {
    return storage.run(ctx || noopCtx, fn);
}

function current() {
    return storage.getStore() || noopCtx;
}

// 业务层长等待点的统一检查入口；CLI 下 control 为 no-op，调用无副作用。
function checkpoint() {
    return current().control.checkpoint();
}

module.exports = { runWithContext, current, noopCtx, createContext, checkpoint };
