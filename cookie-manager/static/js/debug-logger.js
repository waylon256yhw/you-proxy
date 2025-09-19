/**
 * 调试日志
 */
class DebugLogger {
    constructor() {
        this.logs = [];
        this.maxLogs = 1000;
        this.listeners = [];
        this.infoLoggingEnabled = false; // 默认关闭INFO记录
        this.networkLoggingEnabled = false; // 默认关闭Network记录
        this.interceptConsole();
        this.interceptNetwork();

        // 初始日志
        this.addLog('info', ['Cookie Manager Debug Logger initialized']);
    }

    // 设置Network日志记录状态
    setNetworkLogging(enabled) {
        this.networkLoggingEnabled = enabled;
        if (enabled) {
            this.addLog('info', ['Network logging enabled']);
        }
    }

    // 设置INFO日志记录状态
    setInfoLogging(enabled) {
        this.infoLoggingEnabled = enabled;
        if (enabled) {
            this.addLog('info', ['INFO logging enabled']);
        }
    }

    // 拦截console
    interceptConsole() {
        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;
        const originalInfo = console.info;

        console.log = (...args) => {
            const message = args.join(' ');
            if (message.includes('[Operation]')) {
                if (this.infoLoggingEnabled) {
                    this.addLog('info', args);
                }
            } else if (message.includes('[Network]')) {
                if (this.networkLoggingEnabled) {
                    this.addLog('info', args);
                }
            } else {
                this.addLog('log', args);
            }
            originalLog.apply(console, args);
        };

        console.error = (...args) => {
            this.addLog('error', args);
            originalError.apply(console, args);
        };

        console.warn = (...args) => {
            this.addLog('warn', args);
            originalWarn.apply(console, args);
        };

        console.info = (...args) => {
            const message = args.join(' ');
            if (message.includes('[Network]')) {
                if (this.networkLoggingEnabled) {
                    this.addLog('info', args);
                }
            } else if (this.infoLoggingEnabled) {
                this.addLog('info', args);
            }
            originalInfo.apply(console, args);
        };

        // 捕获全局错误
        window.addEventListener('error', (event) => {
            this.addLog('error', [`${event.message} at ${event.filename}:${event.lineno}:${event.colno}`]);
        });

        window.addEventListener('unhandledrejection', (event) => {
            this.addLog('error', ['Unhandled Promise Rejection:', event.reason]);
        });
    }

    interceptNetwork() {
        // 拦截 fetch
        const originalFetch = window.fetch;
        window.fetch = async (input, init) => {
            const startTime = performance.now();

            if (this.networkLoggingEnabled) {
                this.addLog('info', [`[Network] Fetch ${init?.method || 'GET'} ${input}`]);
            }

            try {
                const response = await originalFetch(input, init);
                const duration = performance.now() - startTime;

                if (this.networkLoggingEnabled) {
                    this.addLog('info', [`[Network] Response ${response.status} ${input} (${duration.toFixed(2)}ms)`]);
                }

                return response;
            } catch (error) {
                const duration = performance.now() - startTime;
                this.addLog('error', [`[Network] Failed ${input} (${duration.toFixed(2)}ms)`, error.message]);
                throw error;
            }
        };
    }

    addLog(type, args) {
        const log = {
            type,
            timestamp: new Date().toISOString(),
            message: args.map(arg => {
                if (typeof arg === 'object') {
                    try {
                        return JSON.stringify(arg, null, 2);
                    } catch {
                        return String(arg);
                    }
                }
                return String(arg);
            }).join(' ')
        };

        this.logs.push(log);

        // 限制日志数量
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        // 通知
        this.listeners.forEach(listener => listener(log));
    }

    getLogs(filter = null, includeInfo = true) {
        let logs = this.logs;

        // 如果不包含INFO，先过滤掉
        if (!includeInfo) {
            logs = logs.filter(log => log.type !== 'info');
        }

        // 再应用类型过滤
        if (filter) {
            logs = logs.filter(log => log.type === filter);
        }

        return logs;
    }

    clearLogs() {
        this.logs = [];
    }

    subscribe(listener) {
        this.listeners.push(listener);
    }

    unsubscribe(listener) {
        this.listeners = this.listeners.filter(l => l !== listener);
    }
}

window.debugLogger = new DebugLogger();