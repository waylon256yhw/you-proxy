import fs from 'fs';
import path from 'path';
import {Mutex} from 'async-mutex';
import winston from 'winston';

// 请求日志记录
const logFilePath = path.join(process.cwd(), 'request_logs.log');

/*
 * 黑名单文件格式：
 * {
 *    "ip1": {
 *       "permanent": true
 *   },
 *   "ip2": {
 *      "permanent": true
 *  }
 * ...
 */
const blacklistFilePath = path.join(process.cwd(), 'ip_blacklist.json');

/*
 * 临时限制文件格式：
 * {
 *   "ip1": 1630000000000,
 *  "ip2": 1630000000000
 * ...
 * }
 */
const tempLimitFilePath = path.join(process.cwd(), 'temp_limits.json');

// 是否启用检测
const ENABLE_DETECTION = process.env.ENABLE_DETECTION !== 'false';

class RequestLogger {
    constructor() {
        // 日志记录
        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp({format: 'YYYY年MM月DD日 HH时mm分ss秒'}),
                winston.format.printf(({timestamp, level, message}) => {
                    return `${timestamp} | ${message}`;
                })
            ),
            transports: [
                new winston.transports.File({filename: logFilePath})
            ]
        });

        // 初始化黑名单
        try {
            if (!fs.existsSync(blacklistFilePath)) {
                fs.writeFileSync(blacklistFilePath, JSON.stringify({}), 'utf8');
            }
        } catch (err) {
            console.error(`初始化黑名单文件出错：${err.message}`);
        }

        this.ipRequestRecords = {};  // 每个IP的请求时间记录
        this.ip30sTriggerCount = {};  // 统计每个IP触发30秒限制的次数
        this.temporaryLimits = {};  // 每个IP的临时限制到期时间
        this.ipMutexes = {};  // 为每个IP分配一个独立的Mutex
        this.blacklistMutex = new Mutex();  // 黑名单文件的Mutex
        this.tempLimitsFileMutex = new Mutex(); // 临时限制文件Mutex
        this.isWatcherActive = false; // 监听器状态
        this.pendingSave = false; // 是否有待保存更改

        // 初始化临时限制文件
        try {
            if (!fs.existsSync(tempLimitFilePath)) {
                fs.writeFileSync(tempLimitFilePath, JSON.stringify({}), 'utf8');
            }
        } catch (err) {
            console.error(`初始化临时限制文件出错：${err.message}`);
        }

        // 加载临时限制
        this.loadTempLimitsFromFile();

        // 监听文件变化
        setTimeout(() => {
            this.setupTempLimitsFileWatcher();
        }, 1000);

        // 清理无活动IP
        setInterval(() => {
            this.cleanUpInactiveIPs();
        }, 60 * 60 * 1000);

        // 批量保存
        this.saveDebounceTimer = null;
    }

    // 获取IP的Mutex
    getMutexForIP(ip) {
        if (!this.ipMutexes[ip]) {
            this.ipMutexes[ip] = new Mutex();
        }
        return this.ipMutexes[ip];
    }

    // 原子写入文件
    async atomicWriteFile(filepath, data, retries = 3) {
        const tempFile = `${filepath}.tmp`;

        for (let i = 0; i < retries; i++) {
            try {
                // 写入临时
                await fs.promises.writeFile(tempFile, data, 'utf8');

                await fs.promises.rename(tempFile, filepath);
                return true;
            } catch (error) {
                if (error.code === 'EBUSY' && i < retries - 1) {
                    // EBUSY错误
                    await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
                    continue;
                } else if (i === retries - 1) {
                    try {
                        await fs.promises.unlink(tempFile).catch(() => {});
                    } catch {}
                    throw error;
                }
            }
        }
        return false;
    }

    // 从文件加载临时限制
    async loadTempLimitsFromFile() {
        try {
            const dataRaw = await fs.promises.readFile(tempLimitFilePath, 'utf8');
            if (!dataRaw.trim()) {
                return;
            }
            const parsed = JSON.parse(dataRaw);
            const now = Date.now();
            // 清空内存
            this.temporaryLimits = {};
            for (const ip in parsed) {
                const expireTime = parseInt(parsed[ip], 10);
                if (!isNaN(expireTime) && expireTime > now) {
                    this.temporaryLimits[ip] = expireTime;
                }
            }
            // 清理过期记录
            this.scheduleSave();
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`读取临时限制文件出错：${error.message}`);
            }
        }
    }

    scheduleSave() {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
        }

        this.pendingSave = true;
        this.saveDebounceTimer = setTimeout(() => {
            this.saveTempLimitsToFile();
        }, 500);
    }

    // 保存临时限制到文件
    async saveTempLimitsToFile() {
        if (!this.pendingSave) return;

        await this.tempLimitsFileMutex.runExclusive(async () => {
            try {
                const wasWatcherActive = this.isWatcherActive;
                if (wasWatcherActive && this.watcher) {
                    this.isWatcherActive = false;
                }

                const now = Date.now();
                // 移除过期
                const cleanedLimits = {};
                for (const ip in this.temporaryLimits) {
                    if (this.temporaryLimits[ip] > now) {
                        cleanedLimits[ip] = this.temporaryLimits[ip];
                    }
                }
                this.temporaryLimits = cleanedLimits;

                // 原子写入
                const data = JSON.stringify(this.temporaryLimits, null, 4);
                await this.atomicWriteFile(tempLimitFilePath, data);

                this.pendingSave = false;

                // 恢复监听器
                if (wasWatcherActive) {
                    setTimeout(() => {
                        this.isWatcherActive = true;
                    }, 100);
                }
            } catch (error) {
                console.error(`写入临时限制文件出错：${error.message}`);
                setTimeout(() => {
                    this.scheduleSave();
                }, 1000);
            }
        });
    }

    // 设置文件监听器
    setupTempLimitsFileWatcher() {
        try {
            const options = {
                persistent: false,
                interval: 1000
            };

            this.watcher = fs.watch(tempLimitFilePath, options, (eventType) => {
                if (eventType === 'change' && this.isWatcherActive && !this.pendingSave) {
                    if (this.loadDebounceTimer) {
                        clearTimeout(this.loadDebounceTimer);
                    }
                    this.loadDebounceTimer = setTimeout(() => {
                        this.loadTempLimitsFromFile();
                    }, 200);
                }
            });

            this.isWatcherActive = true;
        } catch (err) {
            console.error(`监听临时限制文件出错：${err.message}`);
        }
    }

    // 检查是否在黑名单
    async isBlacklisted(ip) {
        return await this.blacklistMutex.runExclusive(async () => {
            try {
                if (!fs.existsSync(blacklistFilePath)) {
                    await this.atomicWriteFile(blacklistFilePath, JSON.stringify({}));
                }
                const blacklistData = await fs.promises.readFile(blacklistFilePath, 'utf8');
                const blacklist = JSON.parse(blacklistData || '{}');
                const info = blacklist[ip];
                if (info && info.permanent) {
                    return true;
                } else if (info) {
                    // 移除非法记录
                    delete blacklist[ip];
                    await this.atomicWriteFile(blacklistFilePath, JSON.stringify(blacklist, null, 4));
                    return false;
                }
                return false;
            } catch (err) {
                console.error(`读取黑名单文件出错：${err.message}`);
                return false;
            }
        });
    }

    // 将IP添加到黑名单
    async addToBlacklist(ip) {
        await this.blacklistMutex.runExclusive(async () => {
            try {
                if (!fs.existsSync(blacklistFilePath)) {
                    await this.atomicWriteFile(blacklistFilePath, JSON.stringify({}));
                }
                const dataRaw = await fs.promises.readFile(blacklistFilePath, 'utf8');
                const blacklist = JSON.parse(dataRaw || '{}');

                if (!blacklist[ip]) {
                    blacklist[ip] = {permanent: true};
                    await this.atomicWriteFile(
                        blacklistFilePath,
                        JSON.stringify(blacklist, null, 4)
                    );
                }
            } catch (err) {
                console.error(`写入黑名单文件出错：${err.message}`);
            }
        });
    }

    // 检查是否有临时限制
    _hasTemporaryLimit(ip) {
        const now = Date.now();
        if (this.temporaryLimits[ip] && now < this.temporaryLimits[ip]) {
            return true;
        }
        delete this.temporaryLimits[ip];
        return false;
    }

    // 获取剩余限制时间
    _getRemainingTime(ip) {
        const now = Date.now();
        if (this.temporaryLimits[ip] && now < this.temporaryLimits[ip]) {
            const remaining = this.temporaryLimits[ip] - now;
            const hh = Math.floor(remaining / 3600000);
            const mm = Math.floor((remaining % 3600000) / 60000);
            const ss = Math.floor((remaining % 60000) / 1000);
            if (hh > 0) {
                return `${hh}小时${mm}分${ss}秒`;
            } else if (mm > 0) {
                return `${mm}分${ss}秒`;
            } else {
                return `${ss}秒`;
            }
        }
        return '未知时间';
    }

    // 清理过期的请求记录
    _cleanUpRecords(ip) {
        const now = Date.now();
        // 请求记录保留24小时
        if (this.ipRequestRecords[ip]) {
            this.ipRequestRecords[ip] = this.ipRequestRecords[ip].filter(
                t => now - t <= 24 * 60 * 60 * 1000
            );
        }
        // 30秒触发记录同样保留24小时
        if (this.ip30sTriggerCount[ip]) {
            this.ip30sTriggerCount[ip] = this.ip30sTriggerCount[ip].filter(
                t => now - t <= 24 * 60 * 60 * 1000
            );
        }
        // 清理过期的临时限制
        if (this.temporaryLimits[ip] && now >= this.temporaryLimits[ip]) {
            delete this.temporaryLimits[ip];
            this.scheduleSave();
        }
    }

    // 定期清理长期未活动的IP数据
    cleanUpInactiveIPs() {
        let hasChanges = false;
        for (const ip in this.ipRequestRecords) {
            const noRecentRequests = !this.ipRequestRecords[ip] || this.ipRequestRecords[ip].length === 0;
            const no30sTriggers = !this.ip30sTriggerCount[ip] || this.ip30sTriggerCount[ip].length === 0;

            // 若该IP无请求记录、无30秒触发记录且无临时限制
            if (noRecentRequests && no30sTriggers && !this._hasTemporaryLimit(ip)) {
                delete this.ipRequestRecords[ip];
                delete this.ip30sTriggerCount[ip];
                delete this.ipMutexes[ip];
                hasChanges = true;
            }
        }

        if (hasChanges) {
            this.scheduleSave();
        }
    }

    // 记录请求并检测
    async logRequest({time, ip, location, model, session}) {
        if (ENABLE_DETECTION && await this.isBlacklisted(ip)) {
            throw new Error(`您已被永久限制。`);
        }
        const baseInfo = `IP: ${ip} | Location: ${location} | Model: ${model} | Session: ${session}`;
        if (!ENABLE_DETECTION) {
            this.logger.info(baseInfo);
            return;
        }

        let limitInfo = '';
        const ipMutex = this.getMutexForIP(ip);
        let needLog = true;

        try {
            await ipMutex.runExclusive(async () => {
                const now = Date.now();

                // 检查临时限制
                if (this._hasTemporaryLimit(ip)) {
                    const rt = this._getRemainingTime(ip);
                    limitInfo = ` | Limit: ${this.temporaryLimits[ip] - now}ms`;
                    throw new Error(`您被限制访问，请在${rt}后再试。`);
                }

                // 记录请求 & 清理
                if (!this.ipRequestRecords[ip]) {
                    this.ipRequestRecords[ip] = [];
                }
                this.ipRequestRecords[ip].push(now);
                this._cleanUpRecords(ip);

                // >=4次/6秒 → 加入黑名单
                const requestsIn6s = this.ipRequestRecords[ip].filter(
                    t => now - t <= 6 * 1000
                );
                if (requestsIn6s.length >= 3) {
                    await this.addToBlacklist(ip);
                    limitInfo = ' | Limit: PERMANENT';
                    throw new Error(`并发请求过多，已永久限制。`);
                }

                // >=3次/30秒 → 临时限制
                const requestsIn30s = this.ipRequestRecords[ip].filter(
                    t => now - t <= 30 * 1000
                );
                if (requestsIn30s.length >= 3) {
                    if (!this.ip30sTriggerCount[ip]) {
                        this.ip30sTriggerCount[ip] = [];
                    }
                    this.ip30sTriggerCount[ip].push(now);
                    this._cleanUpRecords(ip);

                    // 24小时内触发次数 >= 5 → 限制6小时
                    if (this.ip30sTriggerCount[ip].length >= 5) {
                        const duration = 6 * 60 * 60 * 1000;
                        this.temporaryLimits[ip] = now + duration;
                        limitInfo = ` | Limit: ${duration}ms`;
                        this.scheduleSave();
                        throw new Error(`您在24小时内多次频繁请求，限制6小时`);
                    } else {
                        const duration = 60 * 1000;
                        this.temporaryLimits[ip] = now + duration;
                        limitInfo = ` | Limit: ${duration}ms`;
                        this.scheduleSave();
                        throw new Error(`请求过多, 限制1分钟`);
                    }
                }
            });
        } catch (err) {
            this.logger.info(`${baseInfo}${limitInfo}`);
            throw err;
        }
        if (needLog) {
            this.logger.info(`${baseInfo}${limitInfo}`);
        }
    }

    // 清理资源
    async cleanup() {
        // 关闭文件监听器
        if (this.watcher) {
            this.watcher.close();
        }

        // 清除定时器
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
        }
        if (this.loadDebounceTimer) {
            clearTimeout(this.loadDebounceTimer);
        }

        // 保存最后更改
        if (this.pendingSave) {
            await this.saveTempLimitsToFile();
        }
    }
}

export default RequestLogger;