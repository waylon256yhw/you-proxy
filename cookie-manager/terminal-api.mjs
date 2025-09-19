import { WebSocketServer } from 'ws';
import { cookieDebugger } from './debugger.mjs';
import { authManager } from './auth.mjs';

// 全局常量
const TERMINAL_CONFIG = {
    MAX_HISTORY_LENGTH: 2000,  // 最大历史记录
    RECENT_HISTORY_SEND: 200,  // 发送给新连接最近历史
    BUFFER_TIMEOUT: 350,        // 缓冲区超时时间(ms)
    DEDUP_TIME_WINDOW: 100     // 去重时间窗口(ms)
};

let wsClients = new Set();
let outputHistory = [];
let lastOutputTime = 0;
let lastOutputContent = '';

// 原始写入
let originalStdoutWrite = null;
let originalStderrWrite = null;
let originalConsoleLog = null;
let originalConsoleError = null;
let originalConsoleWarn = null;

// 标记初始化
let isInitialized = false;
// 标记 console
let isFromConsole = false;

/**
 * 初始化输出（服务器启动前）
 */
export function initializeOutputCapture() {
    if (isInitialized) return;
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    originalConsoleLog = console.log.bind(console);
    originalConsoleError = console.error.bind(console);
    originalConsoleWarn = console.warn.bind(console);

    interceptOutput();
    isInitialized = true;

    addToHistory('[Terminal] 输出捕获初始化\n');
}

/**
 * 添加到历史记录
 */
function addToHistory(message) {
    const now = Date.now();

    // 防相同内容在短时间重复添加
    if (message === lastOutputContent && (now - lastOutputTime) < TERMINAL_CONFIG.DEDUP_TIME_WINDOW) {
        return;
    }

    lastOutputContent = message;
    lastOutputTime = now;

    outputHistory.push({
        timestamp: new Date().toISOString(),
        message: message
    });

    // 限制历史记录长度
    if (outputHistory.length > TERMINAL_CONFIG.MAX_HISTORY_LENGTH) {
        outputHistory.shift();
    }
}

/**
 * 从Cookie获取session
 */
function getSessionFromCookie(cookieString) {
    if (!cookieString) return null;
    const cookies = cookieString.split(';');
    for (const cookie of cookies) {
        const [key, value] = cookie.trim().split('=');
        if (key === 'cm_session') {
            return value;
        }
    }
    return null;
}

/**
 * 设置终端API
 */
export function setupTerminalAPI(server) {
    if (!isInitialized) {
        initializeOutputCapture();
    }

    const wss = new WebSocketServer({
        server,
        path: '/cookie-manager/api/terminal/ws',
        verifyClient: (info, callback) => {
            const cookie = info.req.headers.cookie;
            const sessionId = getSessionFromCookie(cookie);
            const url = new URL(info.req.url, `http://${info.req.headers.host}`);
            const urlSessionId = url.searchParams.get('session');

            const validSessionId = sessionId || urlSessionId;

            if (!validSessionId || !authManager.verifySession(validSessionId)) {
                cookieDebugger.log('Terminal', 'Unauthorized WebSocket connection attempt');
                callback(false, 401, 'Unauthorized');
                return;
            }

            callback(true);
        }
    });

    wss.on('connection', (ws, req) => {
        cookieDebugger.log('Terminal', 'Client connected');
        wsClients.add(ws);
        ws.send('=== Cookie Manager Terminal ===\n');
        
        // 发送历史输出
        if (outputHistory.length > 0) {
            ws.send(`=== 历史输出 (最近 ${Math.min(outputHistory.length, TERMINAL_CONFIG.RECENT_HISTORY_SEND)} 条) ===\n`);

            const recentHistory = outputHistory.slice(-TERMINAL_CONFIG.RECENT_HISTORY_SEND);

            recentHistory.forEach(item => {
                ws.send(`[${new Date(item.timestamp).toLocaleTimeString()}] ${item.message}`);
            });
            ws.send('=== 实时输出 ===\n');
        }

        ws.on('close', () => {
            cookieDebugger.log('Terminal', 'Client disconnected');
            wsClients.delete(ws);
        });

        ws.on('error', (error) => {
            cookieDebugger.error('Terminal', 'WebSocket error', error);
            wsClients.delete(ws);
        });
    });
}

/**
 * 检查日志标记
 */
function hasLogPrefix(message) {
    return /^\[(LOG|ERROR|WARN|INFO|DEBUG)\]/.test(message);
}

/**
 * 拦截输出（只执行一次）
 */
function interceptOutput() {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let stdoutTimer = null;
    let stderrTimer = null;

    process.stdout.write = function(chunk, encoding, callback) {
        if (!isFromConsole && chunk) {
            const str = chunk.toString();

            if (!hasLogPrefix(str)) {
                // 流式
                stdoutBuffer += str;

                // 清除之前定时器
                if (stdoutTimer) clearTimeout(stdoutTimer);

                // 如果包含换行
                if (str.includes('\n')) {
                    const lines = stdoutBuffer.split('\n');
                    const complete = lines.slice(0, -1).join('\n');
                    stdoutBuffer = lines[lines.length - 1];

                    if (complete) {
                        const message = complete + '\n';
                        broadcast(message);
                        addToHistory(message);
                    }
                }

                // 设置新定时器
                stdoutTimer = setTimeout(() => {
                    if (stdoutBuffer) {
                        broadcast(stdoutBuffer);
                        addToHistory(stdoutBuffer);
                        stdoutBuffer = '';
                    }
                }, TERMINAL_CONFIG.BUFFER_TIMEOUT);
            }
        }

        // 处理参数
        if (typeof encoding === 'function') {
            callback = encoding;
            encoding = undefined;
        }

        if (callback) {
            return originalStdoutWrite(chunk, encoding, callback);
        } else if (encoding) {
            return originalStdoutWrite(chunk, encoding);
        } else {
            return originalStdoutWrite(chunk);
        }
    };

    process.stderr.write = function(chunk, encoding, callback) {
        if (!isFromConsole && chunk) {
            const str = chunk.toString();

            // 只处理不带 [ERROR]
            if (!hasLogPrefix(str)) {
                stderrBuffer += str;

                if (stderrTimer) clearTimeout(stderrTimer);

                if (str.includes('\n')) {
                    const lines = stderrBuffer.split('\n');
                    const complete = lines.slice(0, -1).join('\n');
                    stderrBuffer = lines[lines.length - 1];

                    if (complete) {
                        const message = `[ERROR] ${complete}\n`;
                        broadcast(message);
                        addToHistory(message);
                    }
                }

                stderrTimer = setTimeout(() => {
                    if (stderrBuffer) {
                        const message = `[ERROR] ${stderrBuffer}`;
                        broadcast(message);
                        addToHistory(message);
                        stderrBuffer = '';
                    }
                }, TERMINAL_CONFIG.BUFFER_TIMEOUT);
            }
        }

        // 处理参数
        if (typeof encoding === 'function') {
            callback = encoding;
            encoding = undefined;
        }

        if (callback) {
            return originalStderrWrite(chunk, encoding, callback);
        } else if (encoding) {
            return originalStderrWrite(chunk, encoding);
        } else {
            return originalStderrWrite(chunk);
        }
    };

    // 拦截console输出
    interceptConsoleOutput();
}

/**
 * 拦截console
 */
function interceptConsoleOutput() {
    console.log = function(...args) {
        const message = formatConsoleMessage(args);
        const logMessage = `[LOG] ${message}\n`;
        broadcast(logMessage);
        addToHistory(logMessage);

        // 设置标志
        isFromConsole = true;
        originalConsoleLog.apply(console, args);
        isFromConsole = false;
    };

    console.error = function(...args) {
        const message = formatConsoleMessage(args);
        const errorMessage = `[ERROR] ${message}\n`;
        broadcast(errorMessage);
        addToHistory(errorMessage);
        isFromConsole = true;
        originalConsoleError.apply(console, args);
        isFromConsole = false;
    };

    console.warn = function(...args) {
        const message = formatConsoleMessage(args);
        const warnMessage = `[WARN] ${message}\n`;
        broadcast(warnMessage);
        addToHistory(warnMessage);
        isFromConsole = true;
        originalConsoleWarn.apply(console, args);
        isFromConsole = false;
    };
}

/**
 * 格式化console
 */
function formatConsoleMessage(args) {
    return args.map(arg => {
        if (typeof arg === 'object') {
            try {
                return JSON.stringify(arg, null, 2);
            } catch (e) {
                return String(arg);
            }
        }
        return String(arg);
    }).join(' ');
}

/**
 * 广播消息到所有客户端
 */
function broadcast(message) {
    if (!message || message.trim() === '') return;

    wsClients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN = 1
            try {
                client.send(message);
            } catch (error) {
                console.error('Failed to send to client:', error);
            }
        }
    });
}

/**
 * 清空历史记录
 */
export function clearTerminalHistory() {
    outputHistory = [];
}

/**
 * 获取历史记录统计
 */
export function getTerminalStats() {
    return {
        historyLength: outputHistory.length,
        maxHistoryLength: TERMINAL_CONFIG.MAX_HISTORY_LENGTH,
        connectedClients: wsClients.size
    };
}

export { broadcast as broadcastTerminal };