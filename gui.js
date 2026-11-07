const { ensureEnvProxy } = require('./core/runtime');
ensureEnvProxy();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { acquire } = require('./core/single-instance');
const { createBus } = require('./core/event-bus');
const { createServer } = require('./core/http-server');
const { focusWindow, showTray, paths } = require('./core/host');
const { runWithContext, current, createContext } = require('./core/run-context');
const { installSinks, restore } = require('./core/log-sinks');

// 首跑检测：Playwright 与托盘组件任一缺失就算「依赖未就绪」，
// 此时界面照常打开，先显示安装页，装完再进入正常流程
function depsReady() {
    const nm = path.join(paths().root, 'node_modules');
    return fs.existsSync(path.join(nm, 'playwright')) && fs.existsSync(path.join(nm, 'systray2'));
}

// 配置模板的复制从 start.bat 移到这里：无配置时界面也能完成全部引导
function ensureConfigTemplate() {
    const cfg = paths().config;
    if (!fs.existsSync(cfg)) {
        try { fs.copyFileSync(path.join(paths().root, 'config.txt.expample'), cfg); } catch {}
    }
}

function createState(bus) {
    const data = {
        phase: 'idle',
        label: '待命',
        running: false,
        paused: false,
        windowVisible: true
    };
    return {
        get: () => ({ ...data }),
        set(patch) {
            Object.assign(data, patch);
            bus.emit('state', data);
        }
    };
}

async function main() {
    const inst = await acquire();
    if (inst.recalled) return null;

    const token = crypto.randomBytes(12).toString('hex');
    const bus = createBus();
    const state = createState(bus);
    const ctx = createContext({ bus, mode: 'gui', state });
    const url = `http://127.0.0.1:${inst.port}/?token=${token}`;

    return runWithContext(ctx, async () => {
        let closing = false;
        let appChild = null;
        let timer = null;
        let srv = null;
        let tray = null;
        let installing = false;

        async function shutdown(code = 0) {
            if (closing) return;
            closing = true;
            clearInterval(timer);
            if (tray) { try { tray.kill(); } catch {} }
            bus.closeAll();
            restore();
            if (srv) await srv.close();
            process.exit(code);
        }

        function openWindow() {
            appChild = focusWindow(url);
            appChild.on('exit', () => {
                if (closing) return;
                state.set({ windowVisible: false });
                // 关窗行为：tray=最小化继续；exit=退出（任务在跑先停）；ask=重新开窗询问
                const action = require('./core/config-service').getUiState().closeAction || 'ask';
                if (state.get().phase === 'installing' || state.get().phase === 'install-error') return;
                if (action === 'exit') {
                    if (state.get().running) { ctx.control.stop(); ctx.endRun(); }
                    shutdown(0);
                } else if (action === 'ask') {
                    focusWindow(url + '#close-ask');
                }
            });
            state.set({ windowVisible: true });
        }

        function togglePause() {
            if (!state.get().running) return;
            if (state.get().paused) {
                state.set({ paused: false, phase: 'running', label: '运行中' });
                ctx.control.resume();
            } else {
                state.set({ paused: true, phase: 'paused', label: '已暂停' });
                ctx.control.pause();
            }
        }

        function stopTask() {
            state.set({ running: false, paused: false, phase: 'stopped', label: '已停止' });
            ctx.control.stop();
            ctx.endRun();
        }

        // 首跑依赖安装：npm install 的输出逐行推进界面安装页；官方源失败切国内镜像
        function installDeps(onDone) {
            installing = true;
            state.set({ phase: 'installing', label: '准备运行环境', running: false, paused: false });
            const attempt = (registry) => {
                const args = ['install', '--no-fund', '--no-audit'];
                if (registry) args.push('--registry=' + registry);
                bus.emit('log', { level: 'info', tag: '安装', text: registry ? '官方源失败，切换国内镜像重试…' : '开始安装依赖，预计 1~3 分钟…' });
                const child = spawn('npm', args, { cwd: paths().root, shell: true });
                let buf = '';
                child.stdout.on('data', c => {
                    buf += c.toString();
                    const lines = buf.split(/\r?\n/);
                    buf = lines.pop();
                    for (const line of lines) {
                        if (line.trim()) bus.emit('log', { level: 'info', tag: '安装', text: line.trim().slice(0, 160) });
                    }
                });
                child.stderr.on('data', c => {
                    const t = c.toString().trim();
                    if (t) bus.emit('log', { level: 'warn', tag: '安装', text: t.slice(0, 160) });
                });
                child.on('exit', code => {
                    installing = false;
                    if (code === 0 && depsReady()) {
                        state.set({ phase: 'idle', label: '待命', running: false, paused: false });
                        bus.emit('log', { level: 'success', tag: '安装', text: '依赖安装完成' });
                        onDone(true);
                    } else if (!registry) {
                        attempt('https://registry.npmmirror.com');
                    } else {
                        state.set({ phase: 'install-error', label: '依赖安装失败', running: false, paused: false });
                        bus.emit('log', { level: 'error', tag: '安装', text: '依赖安装失败，请在界面点「重试」' });
                        onDone(false);
                    }
                });
            };
            attempt(null);
        }

        srv = createServer({
            bus, token, port: inst.port, state,
            // 记录页的登录态判断与清空要和业务层用同一个 profile 目录
            // （业务层允许用 ICOURSE_PROFILE_DIR 覆盖默认的用户目录）
            profileDir: require('./platform/icourse163/config').PROFILE_DIR,
            handlers: {
                recall: openWindow,
                quit: () => shutdown(0),
                assertContext: () => current().mode === 'gui',
                confirm: (id, choice, noMore) => ctx.resolveConfirm(id, choice, noMore),
                beginRun: () => ctx.beginRun(),
                endRun: () => {
                    ctx.endRun();
                    state.set({ running: false, paused: false });
                },
                controlStop: () => ctx.control.stop(),
                controlPause: () => ctx.control.pause(),
                controlResume: () => ctx.control.resume(),

                // 真实任务：进程内直接调 run(options)，ALS 显式包一层保证任意请求回调都拿得到上下文
                startTask: (options) => {
                    if (!depsReady()) {
                        bus.emit('toast', { level: 'warn', text: '运行环境还没准备好，请先完成依赖安装' });
                        return Promise.resolve();
                    }
                    if (require('./core/config-service').getCourses(paths().config).courses.length === 0) {
                        bus.emit('toast', { level: 'warn', text: '还没有课程地址，先到「课程」页添加' });
                        return Promise.resolve();
                    }
                    return runWithContext(ctx, () => require('./platform/icourse163').run(options));
                },
                installRetry: () => {
                    if (installing || depsReady()) return;
                    installDeps(() => {});
                },
                closeDecision: (choice, remember) => {
                    if (remember) {
                        try { require('./core/config-service').setUiState({ closeAction: choice }); } catch {}
                    }
                    if (choice === 'exit') {
                        if (state.get().running) { ctx.control.stop(); ctx.endRun(); }
                        shutdown(0);
                    }
                }
            }
        });
        await srv.listen();

        installSinks(bus);
        ensureConfigTemplate();

        const timerId = setInterval(() => bus.heartbeat(), 20000);
        timer = timerId;
        process.on('SIGINT', () => shutdown(0));
        process.on('SIGTERM', () => shutdown(0));

        // 首跑先装依赖再挂托盘；托盘组件本身就在依赖里
        if (depsReady()) {
            tray = showTray({
                show: openWindow,
                togglePause,
                stop: stopTask,
                quit: () => shutdown(0)
            });
            if (!tray) {
                bus.emit('log', { level: 'warn', tag: '系统', text: '托盘图标不可用，关窗后服务仍常驻，重复双击可唤回窗口' });
            }
        } else {
            installDeps(ok => {
                if (!ok) return;
                tray = showTray({
                    show: openWindow,
                    togglePause,
                    stop: stopTask,
                    quit: () => shutdown(0)
                });
            });
        }

        openWindow();
        bus.emit('log', { level: 'info', tag: '系统', text: '界面已启动，等待操作' });
        process.stdout.write(`fuckmooc GUI: ${url}\n`);

        return { srv, bus, state, port: inst.port, token, shutdown };
    });
}

if (require.main === module) {
    main().catch(e => {
        process.stdout.write(`启动失败: ${e.message}\n`);
        process.exit(1);
    });
}
