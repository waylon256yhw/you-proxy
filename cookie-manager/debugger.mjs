/**
 * Cookie Manager 调试
 */
export class CookieDebugger {
    constructor() {
        // 初始状态为关闭
        this.enabled = false;
        this.logs = []; // 存储日志
        this.maxLogs = 500;
    }

    // 启用调试
    enable() {
        this.enabled = true;
        this.addLog('System', 'Debug mode enabled');
    }

    // 禁用调试
    disable() {
        this.enabled = false;
        console.log('[Cookie Manager] Debug mode disabled');
    }

    // 切换调试
    toggle() {
        if (this.enabled) {
            this.disable();
        } else {
            this.enable();
        }
        return this.enabled;
    }

    // 获取当前状态
    isEnabled() {
        return this.enabled;
    }

    // 添加日志到缓存
    addLog(category, message, data = null) {
        const log = {
            type: 'log',
            timestamp: new Date().toISOString(),
            category,
            message,
            data
        };

        this.logs.push(log);

        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        return log;
    }

    log(category, message, data = null) {
        if (!this.enabled) return;

        const timestamp = new Date().toISOString();
        const prefix = `[Cookie Manager][${category}]`;

        console.log(`${timestamp} ${prefix} ${message}`);
        if (data) {
            console.log(`${timestamp} ${prefix} Data:`, data);
        }

        // 添加到日志缓存
        this.addLog(category, message, data);
    }

    error(category, message, error) {
        // 错误始终记录
        const timestamp = new Date().toISOString();
        const prefix = `[Cookie Manager][${category}][ERROR]`;

        console.error(`${timestamp} ${prefix} ${message}`);
        if (error) {
            console.error(`${timestamp} ${prefix} Error:`, error);
        }

        // 添加到日志缓存
        const log = {
            type: 'error',
            timestamp: new Date().toISOString(),
            category,
            message,
            error: error ? error.toString() : null
        };

        this.logs.push(log);

        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
    }

    // JWT解析调试
    debugJWT(token) {
        if (!this.enabled) return null;

        try {
            const parts = token.split('.');
            if (parts.length >= 2) {
                const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
                const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

                this.log('JWT', 'Token parsed successfully', {
                    header,
                    payload,
                    email: payload.email
                });

                return {header, payload};
            }
        } catch (error) {
            this.error('JWT', 'Failed to parse token', error);
        }

        return null;
    }

    warn(category, message, data = null) {
        if (!this.enabled) return;

        const timestamp = new Date().toISOString();
        const prefix = `[Cookie Manager][${category}][WARN]`;

        console.warn(`${timestamp} ${prefix} ${message}`);
        if (data) {
            console.warn(`${timestamp} ${prefix} Data:`, data);
        }

        // 添加到日志缓存
        const log = {
            type: 'warn',
            timestamp: new Date().toISOString(),
            category,
            message,
            data
        };

        this.logs.push(log);

        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
    }

    info(category, message, data = null) {
        if (!this.enabled) return;

        const timestamp = new Date().toISOString();
        const prefix = `[Cookie Manager][${category}][INFO]`;

        console.info(`${timestamp} ${prefix} ${message}`);
        if (data) {
            console.info(`${timestamp} ${prefix} Data:`, data);
        }

        // 添加到日志缓存
        const log = {
            type: 'info',
            timestamp: new Date().toISOString(),
            category,
            message,
            data
        };

        this.logs.push(log);

        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
    }

    // 获取日志
    getLogs(filter = null) {
        if (!filter) return this.logs;
        return this.logs.filter(log => log.type === filter);
    }

    // 清空日志
    clearLogs() {
        this.logs = [];
    }
}

export const cookieDebugger = new CookieDebugger();