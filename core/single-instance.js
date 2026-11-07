const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { paths } = require('./host');

const START_PORT = 17863;
const END_PORT = 17870;

function probe(port) {
    return new Promise(resolve => {
        const req = http.get({
            host: '127.0.0.1', port, path: '/api/health', timeout: 700
        }, res => {
            const ours = res.headers['x-fuckmooc-app'] === '1';
            res.resume();
            resolve(ours);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function recall(port) {
    return new Promise(resolve => {
        const body = '';
        const req = http.request({
            host: '127.0.0.1', port, path: '/api/window/recall',
            method: 'POST', timeout: 1500,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
        }, res => { res.resume(); resolve(true); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end(body);
    });
}

function readLastPort() {
    try {
        const n = Number(JSON.parse(fs.readFileSync(paths().appPortFile, 'utf8')).port);
        return Number.isInteger(n) && n >= START_PORT && n <= END_PORT ? n : START_PORT;
    } catch {
        return START_PORT;
    }
}

function rememberPort(port) {
    try {
        fs.mkdirSync(path.dirname(paths().appPortFile), { recursive: true });
        fs.writeFileSync(paths().appPortFile, JSON.stringify({ port }), 'utf8');
    } catch {}
}

// probe 只能识别自己的实例；端口被其他程序占用时 probe 会失败但 listen 也会失败，
// 所以候选端口先用一次真实绑定验证，绑不上就换下一个
function canBind(port) {
    return new Promise(resolve => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '127.0.0.1');
    });
}

// 端口即锁：命中自己的实例就唤回并让第二个进程退出，
// 这样第二个进程永远走不到 launchPersistentContext()，不会出现「profile 正被占用」。
async function acquire() {
    const last = readLastPort();
    const order = [last];
    for (let p = START_PORT; p <= END_PORT; p++) if (!order.includes(p)) order.push(p);

    for (const port of order) {
        if (await probe(port)) {
            await recall(port);
            return { recalled: true, port };
        }
        if (await canBind(port)) {
            rememberPort(port);
            return { recalled: false, port };
        }
    }
    return { recalled: false, port: START_PORT };
}

module.exports = { acquire, readLastPort, rememberPort, START_PORT, END_PORT };
