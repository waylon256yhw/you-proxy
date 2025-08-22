import fs from 'fs';
import path from 'path';
import {Mutex} from 'async-mutex';
import {fileURLToPath} from 'url';
import {detectBrowser} from './utils/browserDetector.mjs';
import browserFactory from "./utils/browserFactory.mjs";
import {createDirectoryIfNotExists} from './utils/cookieUtils.mjs';
import { getModeStatus, getInitialMode } from './utils/modeUtils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isHeadless = process.env.HEADLESS_BROWSER === 'true' && process.env.USE_MANUAL_LOGIN !== 'true';
const SESSION_LOCK_TIMEOUT = parseInt(process.env.SESSION_LOCK_TIMEOUT || '0', 10);
const COOLDOWN_DURATION = 6 * 60 * 60 * 1000; //记录6小时冷却
// 存储已达请求上限的账号(格式: "timestamp | username")
const cooldownFilePath = path.join(__dirname, 'cooldownAccounts.log');
// 是否启用Cookie持久模式
const COOKIE_PERSISTENCE_MODE = process.env.COOKIE_PERSISTENCE_MODE === "true";

/**
 * 会话管理器
 */
class SessionManager {
    /**
     * @param {Object} provider - 提供者
     */
    constructor(provider) {
        this.provider = provider;
        this.isCustomModeEnabled = process.env.USE_CUSTOM_MODE === 'true';
        this.isRotationEnabled = process.env.ENABLE_MODE_ROTATION === 'true';
        this.isHeadless = isHeadless; // 是否隐藏浏览器
        this.currentIndex = 0;
        this.usernameList = []; // 缓存用户名列表
        this.browserInstances = []; // 浏览器实例数组
        this.browserMutex = new Mutex(); // 浏览器互斥锁
        this.browserIndex = 0;
        this.sessionAutoUnlockTimers = {};
        this.cooldownList = this._loadCooldownList();  // 加载并清理 cooldown 文件
        this._cleanupCooldownList();
        this.BrowserFactory = null; // 初始化时设置
        this.browserFactoryInitialized = false; // 工厂是否初始化
        this._setupAutoCleanup(); // 自动释放资源
        this._setupHealthCheckInterval(); //健康检查
        this._setupMemoryMonitoring(); // 内存监控
        // 指纹配置
        this.fingerprintOptions = {
            enableRotation: process.env.ENABLE_FINGERPRINT_ROTATION === 'true' || true,
            rotationInterval: parseInt(process.env.FINGERPRINT_ROTATION_INTERVAL || '24', 10) * 3600000, // 24小时
            lastRotation: Date.now()
        };
        // Cookie持久模式
        this.isPersistentCookieMode = COOKIE_PERSISTENCE_MODE;
        this.accountBrowserBindings = new Map(); // 账号-浏览器绑定
    }

    /**
     * 设置会话
     * @param {Object} sessions - 会话对象
     */
    setSessions(sessions) {
        this.sessions = sessions;
        this.usernameList = Object.keys(this.sessions);

        // 初始化属性
        for (const username in this.sessions) {
            const session = this.sessions[username];
            session.locked = false;           // 标记会话是否被锁定
            session.requestCount = 0;         // 请求计数
            session.valid = true;            // 标记会话是否有效
            session.mutex = new Mutex();      // 创建互斥锁

            if (!session.modeStatus) {
                session.modeStatus = getModeStatus();
            }
            // 设置初始模式
            if (session.currentMode === undefined) {
                session.currentMode = getInitialMode();
            }
            // 只在轮换模式下启用rotation
            session.rotationEnabled = this.isRotationEnabled &&
                                     session.modeStatus.default &&
                                     session.modeStatus.custom;
            session.switchCounter = 0; // 模式切换计数器
            session.requestsInCurrentMode = 0; // 当前模式下的请求次数
            session.lastDefaultThreshold = 0; // 上次默认模式阈值
            session.switchThreshold = this.provider.getRandomSwitchThreshold(session);

            // 记录请求次数
            session.youTotalRequests = 0;
            // 权重
            if (typeof session.weight !== 'number') {
                session.weight = 1;
            }
        }
    }

    /**
     * 启用持久Cookie
     * @param {boolean} enable
     */
    enablePersistentCookies(enable) {
        this.isPersistentCookieMode = enable;
    }

    /**
     * 初始化浏览器实例
     * @returns {Promise<void>}
     */
    async initBrowserInstancesInBatch() {
        // 初始化工厂
        if (!this.browserFactoryInitialized) {
            await browserFactory.initialize();
            this.browserFactoryInitialized = true;
        }

        let browserCount = (process.env.USE_MANUAL_LOGIN && process.env.USE_MANUAL_LOGIN.toLowerCase() === "true") ? 1 : (parseInt(process.env.BROWSER_INSTANCE_COUNT) || 1);
        const browserOptions = {
            autoDownloadChromium: process.env.AUTO_DOWNLOAD_CHROMIUM !== 'false'
        };
        // 可以是 'auto', 'chromium', 'chrome', 'edge'
        const browserType = process.env.BROWSER_TYPE || 'auto';

        const browserPath = await detectBrowser(browserType, browserOptions);
        if (!browserPath || typeof browserPath !== 'string') {
            throw new Error(`无法获取有效浏览器路径: ${browserPath}`);
        }

        const sharedProfilePath = path.join(__dirname, 'browser_profiles');
        createDirectoryIfNotExists(sharedProfilePath);

        const tasks = [];
        for (let i = 0; i < browserCount; i++) {
            const browserId = `browser_${i}`;
            const userDataDir = path.join(sharedProfilePath, browserId);
            createDirectoryIfNotExists(userDataDir);

            tasks.push(this._createSingleBrowser(browserId, userDataDir, browserPath));
        }

        // 并行执行
        const results = await Promise.all(tasks);
        for (const instanceInfo of results) {
            this.browserInstances.push(instanceInfo);
            console.log(`创建浏览器实例: ${instanceInfo.id}`);
        }
    }

    /**
     * 创建单个浏览器
     * @private
     * @param {String} browserId - 浏览器ID
     * @param {String} userDataDir - 数据目录
     * @param {String} browserPath - 可执行文件路径
     * @returns {Promise<Object>} - 实例
     */
    async _createSingleBrowser(browserId, userDataDir, browserPath) {
        try {
            return await browserFactory.createBrowser(browserId, userDataDir, browserPath);
        } catch (error) {
            console.error(`创建浏览器实例 ${browserId} 失败:`, error);
            return {
                id: browserId,
                error: error.message,
                locked: true,
                isError: true
            };
        }
    }

    /**
     * 获取可用浏览器
     * @returns {Promise<Object>}
     */
    async getAvailableBrowser() {
        if (process.env.HEALTH_CHECK_BEFORE_LOCK === 'true') {
            try {
                await this.triggerHealthCheck(true);
            } catch (error) {
                console.warn('Health check failed:', error.message);
            }
        }

        return await this.browserMutex.runExclusive(async () => {
            const totalBrowsers = this.browserInstances.length;

            for (let i = 0; i < totalBrowsers; i++) {
                const index = (this.browserIndex + i) % totalBrowsers;
                const browserInstance = this.browserInstances[index];

                if (!browserInstance.locked) {
                    // 检查是否更新指纹
                    if (this._shouldRotateFingerprints() && browserInstance.fingerprint) {
                        await browserFactory.updateBrowserFingerprint(browserInstance);
                    }

                    browserInstance.locked = true;
                    this.browserIndex = (index + 1) % totalBrowsers;
                    return browserInstance;
                }
            }
            throw new Error('当前负载已饱和，请稍后再试(以达到最大并发)');
        });
    }

    /**
     * 释放浏览器
     * @param {string} browserId - 浏览器ID
     * @returns {Promise<void>}
     */
    async releaseBrowser(browserId) {
        await this.browserMutex.runExclusive(async () => {
            const browserInstance = this.browserInstances.find(b => b.id === browserId);
            if (browserInstance) {
                browserInstance.locked = false;
            }
        });
    }

    /**
     * 获取可用会话
     * @returns {Promise<Object>} - 包含选择用户名和浏览器实例
     */
    async getAvailableSessions() {
        if (this.isPersistentCookieMode) {
            return await this.getAvailableSessionsForPersistentMode();
        }
        const allSessionsLocked = this.usernameList.every(username => this.sessions[username].locked);
        if (allSessionsLocked) {
            throw new Error('所有会话处于饱和状态，请稍后再试(无可用账号)');
        }

        // 收集所有可用会话
        const candidates = [];
        for (const username of this.usernameList) {
            const session = this.sessions[username];
            // 如果没被锁 并且 session.valid
            if (session.valid && !session.locked) {
                if (this.provider.enableRequestLimit && this._isInCooldown(username)) {
                    continue;
                }
                candidates.push(username);
            }
        }

        if (candidates.length === 0) {
            throw new Error('没有可用的账号(会话)');
        }

        // 基于使用率智能选择
        const selectedUsername = this._intelligentSelection(candidates);
        const selectedSession = this.sessions[selectedUsername];

        // 尝试锁定会话
        const result = await selectedSession.mutex.runExclusive(async () => {
            if (selectedSession.locked) {
                return null;
            }

            // 判断是否可用
            if (selectedSession.modeStatus && selectedSession.modeStatus[selectedSession.currentMode]) {
                // 锁定
                selectedSession.locked = true;
                selectedSession.requestCount++;
                selectedSession.lastUsedTime = Date.now(); // 记录最后使用时间

                const browserInstance = await this.getAvailableBrowser();

                // 启动自动解锁计时器
                if (SESSION_LOCK_TIMEOUT > 0) {
                    this._startAutoUnlockTimer(selectedUsername, browserInstance.id);
                }

                return {
                    selectedUsername,
                    modeSwitched: false,
                    browserInstance
                };
            } else if (
                this.isCustomModeEnabled &&
                this.isRotationEnabled &&
                this.provider &&
                typeof this.provider.switchMode === 'function'
            ) {
                console.warn(`尝试为账号 ${selectedUsername} 切换模式...`);
                this.provider.switchMode(selectedSession);
                selectedSession.rotationEnabled = false;

                if (selectedSession.modeStatus && selectedSession.modeStatus[selectedSession.currentMode]) {
                    selectedSession.locked = true;
                    selectedSession.requestCount++;
                    selectedSession.lastUsedTime = Date.now();

                    const browserInstance = await this.getAvailableBrowser();

                    if (SESSION_LOCK_TIMEOUT > 0) {
                        this._startAutoUnlockTimer(selectedUsername, browserInstance.id);
                    }

                    return {
                        selectedUsername,
                        modeSwitched: true,
                        browserInstance
                    };
                }
            }

            return null;
        });

        if (result) {
            // 定期输出均衡统计
            this._logBalanceStatisticsIfNeeded();
            return result;
        } else {
            throw new Error('会话刚被占用或模式不可用!');
        }
    }

    /**
     * 持久模式会话选择
     * @returns {Promise<Object>}
     */
    async getAvailableSessionsForPersistentMode() {
        const allSessionsLocked = this.usernameList.every(username => {
            const session = this.sessions[username];
            return !session || session.locked || !session.valid ||
                   !this.accountBrowserBindings.has(username) ||
                   // 检查是否所有模式都不可用
                   (!session.modeStatus?.default && !session.modeStatus?.custom);
        });

        if (allSessionsLocked) {
            throw new Error('所有会话处于饱和状态，请稍后再试(无可用账号)');
        }

        // 收集所有可用账号&浏览器
        const candidates = [];
        for (const username of this.usernameList) {
            const session = this.sessions[username];
            if (!session) continue;

            const browserInstance = this.accountBrowserBindings.get(username);

            // 检查会话和浏览器
            if (session.valid && !session.locked && browserInstance && !browserInstance.locked &&
                (session.modeStatus?.default || session.modeStatus?.custom)) {
                // 是否在冷却中
                if (this.provider.enableRequestLimit && this._isInCooldown(username)) {
                    continue;
                }
                candidates.push(username);
            }
        }

        if (candidates.length === 0) {
            throw new Error('没有可用的账号(会话)');
        }

        // 基于使用率智能选择
        const selectedUsername = this._intelligentSelection(candidates);
        const selectedSession = this.sessions[selectedUsername];
        const selectedBrowser = this.accountBrowserBindings.get(selectedUsername);

        const result = await selectedSession.mutex.runExclusive(async () => {
            if (selectedSession.locked) {
                return null;
            }

            // 绑定浏览器是否可用
            if (selectedBrowser.locked) {
                return null;
            }

            // 当前模式是否可用
            if (selectedSession.modeStatus && selectedSession.modeStatus[selectedSession.currentMode]) {
                // 锁定会话+浏览器
                selectedSession.locked = true;
                selectedBrowser.locked = true;
                selectedSession.requestCount++;

                // 启动自动解锁计时器
                if (SESSION_LOCK_TIMEOUT > 0) {
                    this._startAutoUnlockTimer(selectedUsername, selectedBrowser.id);
                }

                return {
                    selectedUsername,
                    modeSwitched: false,
                    browserInstance: selectedBrowser
                };
            }
            else if (
                this.isCustomModeEnabled &&
                this.isRotationEnabled &&
                this.provider &&
                typeof this.provider.switchMode === 'function'
            ) {
                console.warn(`持久模式：尝试为账号 ${selectedUsername} 切换模式...`);
                this.provider.switchMode(selectedSession);
                selectedSession.rotationEnabled = false;

                if (selectedSession.modeStatus && selectedSession.modeStatus[selectedSession.currentMode]) {
                    selectedSession.locked = true;
                    selectedBrowser.locked = true;
                    selectedSession.requestCount++;
                    selectedSession.lastUsedTime = Date.now();

                    if (SESSION_LOCK_TIMEOUT > 0) {
                        this._startAutoUnlockTimer(selectedUsername, selectedBrowser.id);
                    }

                    return {
                        selectedUsername,
                        modeSwitched: true,
                        browserInstance: selectedBrowser
                    };
                }
            }

            return null;
        });

        if (result) {
            // 定期输出均衡统计
            this._logBalanceStatisticsIfNeeded();
            return result;
        } else {
            throw new Error('持久模式：会话刚被占用或模式不可用!');
        }
    }

    /**
     * 账号与浏览器绑定
     * @param {Array} accounts - 账号列表
     * @param {Array} browserInstances - 浏览器列表
     */
    setupAccountBrowserBinding(accounts, browserInstances) {
        if (!this.isPersistentCookieMode) return;

        // 清空
        this.accountBrowserBindings.clear();

        const minLength = Math.min(accounts.length, browserInstances.length);
        for (let i = 0; i < minLength; i++) {
            this.accountBrowserBindings.set(accounts[i], browserInstances[i]);
        }
    }

    /**
     * 获取与账号绑定的浏览器实例
     * @param {string} username - 账号
     * @returns {Object} - 浏览器实例
     */
    getBoundBrowserInstance(username) {
        if (!this.isPersistentCookieMode) return null;
        return this.accountBrowserBindings.get(username);
    }

    /**
     * 清理和释放
     * @returns {Promise<void>}
     */
    async cleanup() {
        await this.closeAllBrowsers();
        Object.keys(this.sessionAutoUnlockTimers).forEach(username => {
            clearTimeout(this.sessionAutoUnlockTimers[username]);
        });
        this.sessionAutoUnlockTimers = {};

        if (this.healthCheckIntervalId) {
            clearInterval(this.healthCheckIntervalId);
            this.healthCheckIntervalId = null;
        }

        if (this.memoryMonitoringId) {
            clearInterval(this.memoryMonitoringId);
            this.memoryMonitoringId = null;
        }

        this._saveCooldownList();
    }

    /**
     * 重启卡住或崩溃浏览器
     * @returns {Promise<Object>}
     */
    async healthCheck() {
        const report = {
            checked: 0,
            restarted: 0,
            recovered: 0,
            failed: 0,
            issues: []
        };
        await this.browserMutex.runExclusive(async () => {
            for (let i = 0; i < this.browserInstances.length; i++) {
                const instance = this.browserInstances[i];
                report.checked++;

                try {
                    if (instance.locked || instance.isError) {
                        continue;
                    }

                    const isConnected = await this._checkBrowserConnection(instance);
                    if (!isConnected) {
                        console.warn(`Browser ${instance.id} connection abnormal`);
                        report.issues.push(`Browser ${instance.id} connection abnormal`);

                        // 管道尝试恢复连接
                        if (instance.transportType === 'pipe') {
                            const recovered = await browserFactory.recoverPipeConnection(instance);
                            if (recovered) {
                                report.recovered++;
                                console.log(`Pipe connection restored (${instance.id})`);
                                continue;
                            }
                        }

                        const newInstance = await browserFactory.restartBrowser(instance);
                        if (newInstance) {
                            this.browserInstances[i] = newInstance;
                            report.restarted++;
                            this._suggestGarbageCollection();
                        } else {
                            report.failed++;
                            report.issues.push(`Browser ${instance.id} restart failed`);
                        }
                    }
                } catch (error) {
                    report.failed++;
                    report.issues.push(`Browser ${instance.id} health check error: ${error.message}`);
                    console.error(`Browser ${instance.id} health check failed:`, error);
                }
            }

            if (report.restarted > 0 || report.recovered > 0) {
                const memUsage = process.memoryUsage();
                console.log(`Memory usage after health check: RSS ${Math.round(memUsage.rss / 1024 / 1024)}MB, Heap ${Math.round(memUsage.heapUsed / 1024 / 1024)}/${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
            }
        });

        return report;
    }

    /**
     * @private
     */
    _suggestGarbageCollection() {
        if (global.gc) {
            try {
                global.gc();
                console.log("开始垃圾回收,释放内存资源");
            } catch (e) {
                console.warn('垃圾回收失败:', e);
            }
        } else {
            console.log("无法执行垃圾回收 - 请使用 --expose-gc 启动index.mjs以启用此功能");
        }
    }

    /**
     * 内存监控
     * @private
     */
    _setupMemoryMonitoring() {
        const MEMORY_CHECK_INTERVAL = parseInt(process.env.MEMORY_CHECK_INTERVAL || '10', 10) * 60 * 1000;
        if (MEMORY_CHECK_INTERVAL > 0) {
            this.memoryMonitoringId = setInterval(() => {
                const memUsage = process.memoryUsage();
                console.log(`Memory Usage: RSS ${Math.round(memUsage.rss / 1024 / 1024)}MB, Heap ${Math.round(memUsage.heapUsed / 1024 / 1024)}/${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);

                // 设置警告阈值
                const heapWarningThreshold = parseInt(process.env.HEAP_WARNING_THRESHOLD || '1024', 10); // MB
                if (memUsage.heapUsed / 1024 / 1024 > heapWarningThreshold) {
                    console.warn(`⚠️ High memory usage detected! Heap: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
                    // 内存使用过高且启用自动垃圾回收
                    if (process.env.AUTO_GC_ON_HIGH_MEMORY === 'true') {
                        console.log('Attempting forced garbage collection due to high memory usage...');
                        this._suggestGarbageCollection();
                    }
                }
            }, MEMORY_CHECK_INTERVAL);
        }
    }

    /**
     * 触发健康检查
     * @param {boolean} verbose - 输出日志
     * @param {boolean} force
     * @returns {Promise<Object>}
     */
    async triggerHealthCheck(verbose = false, force = false) {
        // 记录内存
        if (verbose) {
            const memUsage = process.memoryUsage();
            console.log(`Memory usage before health check: RSS ${Math.round(memUsage.rss / 1024 / 1024)}MB, Heap ${Math.round(memUsage.heapUsed / 1024 / 1024)}/${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
        }

        const report = await this.healthCheck();

        if (verbose) {
            console.log(`Health check complete: Checked ${report.checked} instances, restarted ${report.restarted}, failed ${report.failed}`);
            if (report.issues.length > 0) {
                console.warn('Issues detected:', report.issues.join('; '));
            }
        }
        return report;
    }

    /**
     * 设置定期健康检查
     * @private
     */
    _setupHealthCheckInterval() {
        const enableHealthCheck = process.env.ENABLE_HEALTH_CHECK === 'true';
        if (!enableHealthCheck) {
            return;
        }

        const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '10', 10) * 60 * 1000;

        if (HEALTH_CHECK_INTERVAL > 0) {
            this.healthCheckIntervalId = setInterval(async () => {
                try {
                    const report = await this.healthCheck();

                    console.log(`Checked ${report.checked} instances, restarted ${report.restarted}, failed ${report.failed}`);
                    if (report.issues.length > 0) {
                        console.warn('Issues detected:', report.issues.join('; '));
                    }
                } catch (error) {
                    console.error('Health check failed:', error);
                }
            }, HEALTH_CHECK_INTERVAL);
        }
    }

    /**
     * 检查浏览器连接
     * @private
     * @param {Object} instance
     * @returns {Promise<boolean>}
     */
    async _checkBrowserConnection(instance) {
        if (!instance || !instance.browser || !instance.page) {
            return false;
        }
        try {
            const isConnected = instance.browser.isConnected ?
                instance.browser.isConnected() :
                !instance.browser._connection?._closed;

            if (!isConnected) {
                return false;
            }

            // 检查页面是否已关闭
            if (instance.page.isClosed()) {
                return false;
            }

            const isPipeTransport = instance.transportType === 'pipe';
            const timeout = isPipeTransport ? 8000 : 5000; // 管道超时时间

            try {
                const response = await Promise.race([
                    instance.page.evaluate(() => true),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Browser health check timeout')), timeout))
                ]);
                return response === true;
            } catch (evalError) {
                if (isPipeTransport) {
                    try {
                        return instance.browser.process() && !instance.browser.process().killed;
                    } catch (processError) {
                        console.warn(`Pipe transport process check failed for ${instance.id}:`, processError.message);
                        return false;
                    }
                }
                return false;
            }
        } catch (error) {
            console.warn(`Browser ${instance.id} connection check failed:`, error);
            return false;
        }
    }

    /**
     * 关闭所有浏览器实例
     */
    async closeAllBrowsers() {
        if (this.browserFactoryInitialized && this.browserInstances.length > 0) {
            await browserFactory.closeAllBrowsers(this.browserInstances);
            this.browserInstances = [];
        }
    }

    /**
     * 设置自动清理
     * @private
     */
    _setupAutoCleanup() {
        const cleanup = async () => {
            await this.cleanup();
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        process.on('uncaughtException', async (error) => {
            console.error('Uncaught exception:', error);
            await this.cleanup();
            process.exit(1);
        });

        process.on('unhandledRejection', async (reason, promise) => {
            console.error('Unhandled Promise rejection:', reason);
            await this.cleanup();
            process.exit(1);
        });
    }

    /**
     * 启动自动解锁计时器
     * @param {string} username - 用户名
     * @param {string} browserId - 浏览器ID
     * @private
     */
    _startAutoUnlockTimer(username, browserId) {
        // 清除可能残留计时器
        if (this.sessionAutoUnlockTimers[username]) {
            clearTimeout(this.sessionAutoUnlockTimers[username]);
        }
        const lockDurationMs = SESSION_LOCK_TIMEOUT * 1000;

        this.sessionAutoUnlockTimers[username] = setTimeout(async () => {
            const session = this.sessions[username];
            if (session && session.locked) {
                console.warn(`会话 "${username}" 已自动解锁`);
                await session.mutex.runExclusive(async () => {
                    session.locked = false;
                });
            }

            if (browserId && this.isPersistentCookieMode) {
                const browserInstance = this.browserInstances.find(b => b.id === browserId);
                if (browserInstance && browserInstance.locked) {
                    await this.browserMutex.runExclusive(async () => {
                        browserInstance.locked = false;
                    });
                }
            }
        }, lockDurationMs);
    }

    /**
     * 释放会话
     * @param {string} username - 用户名
     * @param {string} browserId - 浏览器ID
     * @returns {Promise<void>}
     */
    async releaseSession(username, browserId) {
        const session = this.sessions[username];
        if (session) {
            await session.mutex.runExclusive(() => {
                session.locked = false;
            });
        }

        // 清除计时器
        if (this.sessionAutoUnlockTimers[username]) {
            clearTimeout(this.sessionAutoUnlockTimers[username]);
            delete this.sessionAutoUnlockTimers[username];
        }

        // 释放浏览器实例
        if (browserId) {
            if (this.isPersistentCookieMode) {
                // 仅解锁浏览器，不清理cookie
                await this.browserMutex.runExclusive(async () => {
                    const browserInstance = this.browserInstances.find(b => b.id === browserId);
                    if (browserInstance) {
                        browserInstance.locked = false;
                    }
                });
            } else {
                await this.releaseBrowser(browserId);
            }
        }
    }

    /**
     * 根据策略获取会话
     * @param {string} strategy - 策略名称
     * @returns {Promise<Object>}
     */
    async getSessionByStrategy(strategy = 'round_robin') {
        if (strategy === 'round_robin') {
            return await this.getAvailableSessions();
        }
        throw new Error(`Unimplemented strategy: ${strategy}`);
    }

    /**
     * 记录达到请求上限账号
     * @param {string} username
     */
    recordLimitedAccount(username) {
        const now = Date.now();
        const already = this.cooldownList.find(x => x.username === username);
        if (!already) {
            this.cooldownList.push({time: now, username});
            this._saveCooldownList();
            console.log(`Writing to cooldown list: ${new Date(now).toLocaleString()} | ${username}`);
        }
    }

    /**
     * 加载冷却列表
     * @returns {Array}
     * @private
     */
    _loadCooldownList() {
        try {
            if (!fs.existsSync(cooldownFilePath)) {
                fs.writeFileSync(cooldownFilePath, '', 'utf8');
                return [];
            }

            const lines = fs.readFileSync(cooldownFilePath, 'utf8')
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);

            const arr = [];
            for (const line of lines) {
                const parts = line.split('|').map(x => x.trim());
                if (parts.length === 2) {
                    const timestamp = parseInt(parts[0], 10);
                    const name = parts[1];
                    if (!isNaN(timestamp) && name) {
                        arr.push({time: timestamp, username: name});
                    }
                }
            }

            return arr;
        } catch (err) {
            console.error(`Error reading ${cooldownFilePath}:`, err);
            return [];
        }
    }

    /**
     * 保存冷却列表
     * @private
     */
    _saveCooldownList() {
        try {
            const lines = this.cooldownList.map(item => `${item.time} | ${item.username}`);
            fs.writeFileSync(cooldownFilePath, lines.join('\n') + '\n', 'utf8');
        } catch (err) {
            console.error(`Error writing ${cooldownFilePath}:`, err);
        }
    }

    /**
     * 清理冷却列表
     * @private
     */
    _cleanupCooldownList() {
        const now = Date.now();
        let changed = false;
        this.cooldownList = this.cooldownList.filter(item => {
            const expired = (now - item.time) >= COOLDOWN_DURATION;
            if (expired) changed = true;
            return !expired;
        });

        if (changed) {
            this._saveCooldownList();
        }
    }

    /**
     * 检查账号是否在冷却中
     * @param {string} username
     * @returns {boolean}
     * @private
     */
    _isInCooldown(username) {
        this._cleanupCooldownList();
        return this.cooldownList.some(item => item.username === username);
    }

    /**
     * 是否应该更新指纹
     * @returns {boolean}
     * @private
     */
    _shouldRotateFingerprints() {
        if (!this.fingerprintOptions.enableRotation) return false;

        const now = Date.now();
        const elapsed = now - this.fingerprintOptions.lastRotation;

        if (elapsed >= this.fingerprintOptions.rotationInterval) {
            this.fingerprintOptions.lastRotation = now;
            return true;
        }

        return false;
    }

    /**
     * 基于使用率的动态权重
     * @param {Array} candidates - 候选账号列表
     * @returns {string} - 选中的账号
     * @private
     */
    _intelligentSelection(candidates) {
        // 计算所有候选账号平均请求数
        let totalRequests = 0;
        let minRequests = Infinity;
        let maxRequests = 0;

        for (const username of candidates) {
            const count = this.sessions[username].requestCount;
            totalRequests += count;
            minRequests = Math.min(minRequests, count);
            maxRequests = Math.max(maxRequests, count);
        }

        const avgRequests = candidates.length > 0 ? totalRequests / candidates.length : 0;

        // 如果所有账号使用次数相同或差异很小，使用轮询
        if (maxRequests - minRequests <= 2) {
            const sortedCandidates = [...candidates].sort((a, b) => {
                const countA = this.sessions[a].requestCount;
                const countB = this.sessions[b].requestCount;
                if (countA !== countB) return countA - countB;

                // 如果请求数相同，比较最后使用时间
                const timeA = this.sessions[a].lastUsedTime || 0;
                const timeB = this.sessions[b].lastUsedTime || 0;
                return timeA - timeB;
            });

            return sortedCandidates[0];
        }

        // 动态计算
        const weights = new Map();
        let totalWeight = 0;

        for (const username of candidates) {
            const session = this.sessions[username];
            const requestCount = session.requestCount;

            // 权重计算
            const weight = Math.pow(2, avgRequests - requestCount + 1);

            weights.set(username, Math.max(weight, 0.1)); // 最小权重0.1
            totalWeight += weights.get(username);
        }

        // 加权
        const random = Math.random() * totalWeight;
        let cumulative = 0;

        for (const username of candidates) {
            cumulative += weights.get(username);
            if (random <= cumulative) {
                return username;
            }
        }

        return candidates[0]; // 兜底
    }

    /**
     * 负载均衡统计日志
     * @private
     */
    _logBalanceStatisticsIfNeeded() {
        // 100次请求统计
        if (!this._totalRequestCount) this._totalRequestCount = 0;
        this._totalRequestCount++;

        if (this._totalRequestCount % 100 === 0) {
            console.log('\n📊 === 均衡统计 ===');
            const stats = this.usernameList.map(username => {
                const session = this.sessions[username];
                return {
                    username,
                    requests: session.requestCount,
                    percentage: ((session.requestCount / this._totalRequestCount) * 100).toFixed(2)
                };
            }).sort((a, b) => b.requests - a.requests);

            stats.forEach(stat => {
                const bar = '█'.repeat(Math.floor(stat.percentage / 2));
                console.log(`${stat.username}: ${stat.requests}次 (${stat.percentage}%) ${bar}`);
            });

            const counts = stats.map(s => s.requests);
            const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
            const variance = counts.reduce((sum, count) => sum + Math.pow(count - mean, 2), 0) / counts.length;
            const stdDev = Math.sqrt(variance);

            console.log(`\n📈 平均使用: ${mean.toFixed(2)}次`);
            console.log(`📉 标准差: ${stdDev.toFixed(2)} (越小越均衡)`);
            console.log(`🎯 均衡度: ${(100 - (stdDev / mean * 100)).toFixed(2)}%\n`);
        }
    }
}

export default SessionManager;