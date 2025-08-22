import {EventEmitter} from "events";
import {v4 as uuidV4} from "uuid";
import path from "path";
import fs from "fs";
import {fileURLToPath} from "url";
import {createDocx, extractCookie, extractCookieFields, getSessionCookie, sleep} from "../utils/cookieUtils.mjs";
import {initCookieConfig} from "../utils/cookieConfig.mjs";
import {cookieRegistry} from "../utils/cookieRegistry.mjs";
import {exec} from 'child_process';
import '../proxyAgent.mjs';
import {formatMessages} from '../formatMessages.mjs';
import NetworkMonitor from '../networkMonitor.mjs';
import {insertGarbledText} from './garbledText.mjs';
import * as imageStorage from "../imageStorage.mjs";
import Logger from './logger.mjs';
import {clientState} from "../index.mjs";
import SessionManager from '../sessionManager.mjs';
import {updateLocalConfigCookieByEmailNonBlocking} from './cookieUpdater.mjs';
import crypto from 'node:crypto';
import {browserHistorySimulator} from "../utils/browserHistorySimulator.mjs";
import DebugMessageManager from './debugMessageManager.mjs';
import { getModeStatus } from '../utils/modeUtils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COOKIE_PERSISTENCE_MODE = process.env.COOKIE_PERSISTENCE_MODE === "true";

class YouProvider {
    constructor(config) {
        initCookieConfig(); // 初始化 Cookie 配置
        this.config = config;
        this.sessions = {};
        this.isCustomModeEnabled = process.env.USE_CUSTOM_MODE === "true"; // 是否启用自定义模式
        this.isRotationEnabled = process.env.ENABLE_MODE_ROTATION === "true"; // 是否启用模式轮换
        this.uploadFileFormat = process.env.UPLOAD_FILE_FORMAT || 'docx'; // 上传文件格式
        this.enableRequestLimit = process.env.ENABLE_REQUEST_LIMIT === 'true'; // 是否启用请求次数限制
        this.requestLimit = parseInt(process.env.REQUEST_LIMIT, 10) || 3; // 请求次数上限
        this.networkMonitor = new NetworkMonitor();
        this.logger = new Logger();
        this.isSingleSession = false; // 是否为单账号模式

        // 初始化调试消息管理器
        this.debugManager = new DebugMessageManager(__dirname, 100);
    }

    getRandomSwitchThreshold(session) {
        if (session.currentMode === "default") {
            return Math.floor(Math.random() * 3) + 1;
        } else {
            const minThreshold = session.lastDefaultThreshold || 1;
            const maxThreshold = 4;
            let range = maxThreshold - minThreshold;

            if (range <= 0) {
                session.lastDefaultThreshold = 1;
                range = maxThreshold - session.lastDefaultThreshold;
            }

            // 范围至少 1
            const adjustedRange = range > 0 ? range : 1;
            return Math.floor(Math.random() * adjustedRange) + session.lastDefaultThreshold;
        }
    }

    switchMode(session) {
        if (session.currentMode === "default") {
            session.lastDefaultThreshold = session.switchThreshold;
        }
        session.currentMode = session.currentMode === "custom" ? "default" : "custom";
        session.switchCounter = 0;
        session.requestsInCurrentMode = 0;
        session.switchThreshold = this.getRandomSwitchThreshold(session);
        console.log(`切换到${session.currentMode}模式，将在${session.switchThreshold}次请求后再次切换`);
    }

    async init(config) {
        console.log(`本项目依赖Chrome或Edge浏览器，请勿关闭弹出的浏览器窗口。如果出现错误请检查是否已安装Chrome或Edge浏览器。`);

        const timeout = 120000;
        this.skipAccountValidation = (process.env.SKIP_ACCOUNT_VALIDATION === "true");

        // 统计sessions数量
        let totalSessions = 0;

        this.sessionManager = new SessionManager(this);
        await this.sessionManager.initBrowserInstancesInBatch();

        if (process.env.USE_MANUAL_LOGIN === "true") {
            console.log("当前使用手动登录模式，跳过config.mjs文件中的 cookie 验证");
            // 获取一个浏览器实例
            const browserInstance = this.sessionManager.browserInstances[0];
            const page = browserInstance.page;
            // 手动登录
            console.log(`请在打开的浏览器窗口中手动登录 You.com`);
            await page.goto("https://you.com/?chatMode=custom", {timeout: timeout});
            await sleep(3000); // 等待页面加载完毕

            const {loginInfo, sessionCookie} = await this.waitForManualLogin(page);
            if (sessionCookie) {
                const email = loginInfo || sessionCookie.email || 'manual_login';
                this.sessions[email] = {
                    valid: true,
                    modeStatus: getModeStatus(),
                    isTeamAccount: false,
                    youpro_subscription: "true",

                    // 复制所有提取字段
                    ...extractCookieFields(sessionCookie),

                    // 明确复制认证信息
                    isNewVersion: sessionCookie.isNewVersion,
                    authType: sessionCookie.isNewVersion ? 'new' : 'old',
                };
                delete this.sessions['manual_login'];
                console.log(`成功获取 ${email} 登录的 cookie (${sessionCookie.isNewVersion ? '新版' : '旧版'})`);
                totalSessions++;
                // 设置隐身模式 cookie
                await page.setCookie(...sessionCookie);
                this.sessionManager.setSessions(this.sessions);
            } else {
                console.error(`未能获取有效的登录 cookie`);
                await browserInstance.browser.close();
            }
        } else {
            // 使用配置文件中的 cookie
            const invalidAccounts = config.invalid_accounts || {};

            for (let index = 0; index < config.sessions.length; index++) {
                const session = config.sessions[index];
                // 获取所有字段
                const cookieFields = extractCookie(session.cookie);

                // 检查
                if (cookieRegistry.isValidSession(cookieFields)) {
                    let username;
                    if (cookieFields.ds) {
                        try {
                            const jwt = JSON.parse(Buffer.from(cookieFields.ds.split(".")[1], "base64").toString());
                            username = jwt.email;
                            if (invalidAccounts[username]) {
                                console.log(`跳过标记失效账号 #${index} ${username} (${invalidAccounts[username]})`);
                                continue;
                            }

                            // 创建对象
                            this.sessions[username] = {
                                configIndex: index,
                                ...cookieFields,
                                valid: false,
                                modeStatus: getModeStatus(),
                                isTeamAccount: false,
                                isNewVersion: true // 新版cookie
                            };
                            console.log(`已添加 #${index} ${username} (新版cookie)`);

                            if (!cookieFields.dsr) {
                                console.warn(`警告: 第${index}个cookie缺少DSR字段。`);
                            }
                        } catch (e) {
                            console.error(`解析第${index}个新版cookie失败: ${e.message}`);
                        }
                    } else if (cookieFields.jwtSession && cookieFields.jwtToken) {
                        try {
                            const jwt = JSON.parse(Buffer.from(cookieFields.jwtToken.split(".")[1], "base64").toString());
                            username = jwt.user.name;

                            if (invalidAccounts[username]) {
                                console.log(`跳过标记失效账号 #${index} ${username} (${invalidAccounts[username]})`);
                                continue;
                            }

                            this.sessions[username] = {
                                configIndex: index,
                                ...cookieFields,
                                valid: false,
                                modeStatus: getModeStatus(),
                                isTeamAccount: false,
                                isNewVersion: false // 旧版cookie
                            };
                            console.log(`已添加 #${index} ${username} (旧版cookie)`);
                        } catch (e) {
                            console.error(`解析第${index}个旧版cookie失败: ${e.message}`);
                        }
                    } else {
                        console.error(`第${index}个cookie无效，请重新获取。`);
                    }
                } else {
                    console.error(`第${index}个cookie无效，未检测到有效的DS或stytch_session字段。`);
                }
            }
            totalSessions = Object.keys(this.sessions).length;
            console.log(`已添加 ${totalSessions} 个 cookie`);
            this.sessionManager.setSessions(this.sessions);
        }

        // 输出cookie诊断表格
        this.printCookieDiagnostics();
        // 是否强制多账号模式
        const forceMultiSession = process.env.FORCE_MULTI_SESSION_MODE === "true";
        // Cookie 持久模式
        const persistentCookieMode = COOKIE_PERSISTENCE_MODE;
        // 判断单账号模式
        if (persistentCookieMode) {
            this.isSingleSession = true;
            console.log(`开启 Cookie持久模式 (账号与浏览器实例绑定)`);
        } else if (process.env.USE_MANUAL_LOGIN === "true") {
            this.isSingleSession = true;
            console.log(`开启 单账号模式`);
        } else if (forceMultiSession) {
            this.isSingleSession = false;
            console.log(`开启 单账号cookie清理模式`);
        } else {
            this.isSingleSession = (totalSessions === 1);
            console.log(`开启 ${this.isSingleSession ? "单账号模式" : "多账号模式"} (数量: ${totalSessions})`);
        }
        // 标记传递SessionManager
        if (persistentCookieMode) {
            this.sessionManager.enablePersistentCookies(true);
        }

        // 执行验证
        if (!this.skipAccountValidation) {
            console.log(`开始验证cookie有效性...`);
            // 获取浏览器实例列表
            const browserInstances = this.sessionManager.browserInstances;
            // 创建一个账号队列
            const accountQueue = [...Object.keys(this.sessions)];
            // 并发验证账号
            await this.validateAccounts(browserInstances, accountQueue);
            console.log("订阅信息汇总：");
            for (const [username, session] of Object.entries(this.sessions)) {
                if (session.valid) {
                    console.log(`{${username}:`);
                    if (session.subscriptionInfo) {
                        console.log(`  订阅计划: ${session.subscriptionInfo.planName}`);
                        console.log(`  到期日期: ${session.subscriptionInfo.expirationDate}`);
                        console.log(`  剩余天数: ${session.subscriptionInfo.daysRemaining}天`);
                        if (session.isTeam) {
                            console.log(`  租户ID: ${session.subscriptionInfo.tenantId}`);
                            console.log(`  许可数量: ${session.subscriptionInfo.quantity}`);
                            if (session.subscriptionInfo.usedQuantity !== '未提供') {
                                console.log(`  已使用许可: ${session.subscriptionInfo.usedQuantity}`);
                            }
                            console.log(`  状态: ${session.subscriptionInfo.status}`);
                            console.log(`  计费周期: ${session.subscriptionInfo.interval}`);
                            console.log(`  金额: $${session.subscriptionInfo.amount}/${session.subscriptionInfo.interval}`);

                            if (session.subscriptionInfo.isTrial) {
                                console.log('  📌 注意: 当前为试用期');
                            }
                        }
                        if (session.subscriptionInfo.cancelAtPeriodEnd) {
                            console.log('  ⚠️  注意: 该订阅已设置为在当前周期结束后取消');
                        }
                    } else {
                        console.warn('  账户类型: 非Pro/非Team（功能受限）');
                    }
                    console.log('}');
                }
            }
        } else {
            console.warn('\x1b[33m%s\x1b[0m', '警告: 已跳过账号验证。可能存在账号信息不正确或无效。');
            for (const username in this.sessions) {
                this.sessions[username].valid = true;
                if (!this.sessions[username].youpro_subscription) {
                    this.sessions[username].youpro_subscription = "true";
                }
            }
        }

        // 统计有效 cookie
        const validSessionsCount = Object.keys(this.sessions).filter(u => this.sessions[u].valid).length;
        console.log(`验证完毕，有效cookie数量 ${validSessionsCount}`);
        // 开启网络监控
        await this.networkMonitor.startMonitoring();
    }

    /**
     * 表格形式输出Cookie诊断信息
     */
    printCookieDiagnostics() {
        const sessions = this.sessions;
        const usernames = Object.keys(sessions);
        if (usernames.length === 0) {
            return;
        }
        // 获取所有注册字段
        const fieldNames = cookieRegistry.getFieldNames();

        const fieldLabels = {
            jwtSession: '🔑',
            jwtToken: '🔐',
            ds: '📝',
            dsr: '📋',
            you_subscription: '🔔',
            youpro_subscription: '⭐',
            uuid_guest: '🆔',
            uuid_guest_backup: '🔄',
            safesearch_guest: '🔍',
            ai_model: '🤖',
            total_query_count: '📊',
            cf_clearance: '🛡️',
            youchat_personalization: '👤',
            youchat_smart_learn: '🧠',
            daily_query_count: '📈',
            daily_query_date: '📅',
            has_dismissed_teams_welcome: '🏠',
            has_dismissed_lms_certification_nudge: '🏆'
        };
        // 默认标签
        fieldNames.forEach(name => {
            if (!fieldLabels[name]) {
                fieldLabels[name] = '📎';
            }
        });

        console.log('\n📋 Cookie诊断报告');
        console.log('字段图例:');

        const allFieldNames = [...new Set([...fieldNames, ...Object.keys(fieldLabels)])];

        // 分列显示字段图例，10
        const ITEMS_PER_ROW = 10;
        let legendRows = [];

        for (let i = 0; i < allFieldNames.length; i += ITEMS_PER_ROW) {
            const rowFields = allFieldNames.slice(i, i + ITEMS_PER_ROW);
            const legendRow = rowFields.map(field =>
                `${fieldLabels[field]} ${field}`
            ).join(' | ');

            legendRows.push(legendRow);
        }

        legendRows.forEach(row => console.log(row));
        console.log('\n状态图例: ✅ 存在 | ❌ 缺失 | ◻️ 不适用');
        console.log('─'.repeat(60));

        const excludeFromCoverageFields = ['has_dismissed_teams_welcome'];

        // 紧凑模式
        const compactMode = usernames.length > 5;
        // 排序
        const sortedUsernames = [...usernames].sort();
        // 统计
        let newAuthCount = 0;
        let oldAuthCount = 0;
        let totalFieldsPresent = 0;
        let totalApplicableFields = 0;

        sortedUsernames.forEach(username => {
            const session = sessions[username];
            // 认证类型标记
            let authType = session.authType || 'unknown';
            const isNewAuth = session.ds !== undefined && session.ds !== null;
            const isOldAuth = session.jwtSession !== undefined && session.jwtSession !== null &&
                session.jwtToken !== undefined && session.jwtToken !== null;

            if (authType === 'unknown') {
                if (isNewAuth) authType = 'new';
                else if (isOldAuth) authType = 'old';
            }

            if (authType === 'new') newAuthCount++;
            if (authType === 'old') oldAuthCount++;

            // 用户名长度限制/50
            const displayUsername = username.length > 50 ? username.substring(0, 47) + '...' : username;
            console.log(`${displayUsername} (${authType === 'new' ? '新版' : authType === 'old' ? '旧版' : '未知'})`);
            const authFields = authType === 'new' ? ['ds', 'dsr'] :
                authType === 'old' ? ['jwtSession', 'jwtToken'] :
                    ['jwtSession', 'jwtToken', 'ds', 'dsr'];
            // 确定不适用认证
            const nonApplicableAuthFields = authType === 'new' ? ['jwtSession', 'jwtToken'] :
                authType === 'old' ? ['ds', 'dsr'] : [];
            const commonFields = [
                'you_subscription', 'youpro_subscription',
                'uuid_guest', 'uuid_guest_backup',
                'safesearch_guest', 'ai_model',
                'youchat_personalization', 'youchat_smart_learn',
                'total_query_count', 'daily_query_count', 'daily_query_date',
                'cf_clearance', 'has_dismissed_teams_welcome',
                'has_dismissed_lms_certification_nudge'
            ];

            // 字段总数
            const applicableFields = [...authFields, ...commonFields].filter(
                field => !excludeFromCoverageFields.includes(field)
            );
            totalApplicableFields += applicableFields.length;

            if (compactMode) {
                // 紧凑模式
                let allFieldsStatus = '';
                authFields.forEach(field => {
                    const hasField = session[field] !== undefined && session[field] !== null;
                    allFieldsStatus += `${fieldLabels[field]}${hasField ? '✅' : '❌'} `;
                    if (hasField && !excludeFromCoverageFields.includes(field)) totalFieldsPresent++;
                });
                // 显示其他
                commonFields.forEach(field => {
                    const hasField = session[field] !== undefined && session[field] !== null;
                    allFieldsStatus += `${fieldLabels[field]}${hasField ? '✅' : '❌'} `;
                    if (hasField && !excludeFromCoverageFields.includes(field)) totalFieldsPresent++;
                });

                // 显示不适用认证
                nonApplicableAuthFields.forEach(field => {
                    allFieldsStatus += `${fieldLabels[field]}◻️ `;
                });

                console.log(`  ${allFieldsStatus.trim()}`);
            } else {
                // 详细模式
                const subFields = ['you_subscription', 'youpro_subscription'];
                const idFields = ['uuid_guest', 'uuid_guest_backup'];
                const settingFields = [
                    'safesearch_guest', 'ai_model', 'youchat_personalization',
                    'youchat_smart_learn', 'has_dismissed_teams_welcome'
                ];
                const statsFields = [
                    'total_query_count', 'daily_query_count', 'daily_query_date',
                    'cf_clearance', 'has_dismissed_lms_certification_nudge'
                ];
                // 认证
                const authStatus = authFields.map(field => {
                    const hasField = session[field] !== undefined && session[field] !== null;
                    if (hasField && !excludeFromCoverageFields.includes(field)) totalFieldsPresent++;
                    return `${fieldLabels[field]}${hasField ? '✅' : '❌'}`;
                }).join(' ');

                // 标记不适用认证
                const nonApplicableAuthStatus = nonApplicableAuthFields.map(field =>
                    `${fieldLabels[field]}◻️`
                ).join(' ');
                // 订阅
                const subStatus = subFields.map(field => {
                    const hasField = session[field] !== undefined && session[field] !== null;
                    if (hasField && !excludeFromCoverageFields.includes(field)) totalFieldsPresent++;
                    return `${fieldLabels[field]}${hasField ? '✅' : '❌'}`;
                }).join(' ');
                // ID
                const idStatus = idFields.map(field => {
                    const hasField = session[field] !== undefined && session[field] !== null;
                    if (hasField && !excludeFromCoverageFields.includes(field)) totalFieldsPresent++;
                    return `${fieldLabels[field]}${hasField ? '✅' : '❌'}`;
                }).join(' ');
                // 设置
                const settingStatus = settingFields.map(field => {
                    const hasField = session[field] !== undefined && session[field] !== null;
                    if (hasField && !excludeFromCoverageFields.includes(field)) totalFieldsPresent++;
                    return `${fieldLabels[field]}${hasField ? '✅' : '❌'}`;
                }).join(' ');
                // 统计
                const statsStatus = statsFields.map(field => {
                    const hasField = session[field] !== undefined && session[field] !== null;
                    if (hasField && !excludeFromCoverageFields.includes(field)) totalFieldsPresent++;
                    return `${fieldLabels[field]}${hasField ? '✅' : '❌'}`;
                }).join(' ');

                console.log(`  认证 (关键): ${authStatus}${nonApplicableAuthFields.length > 0 ? ' | 不适用: ' + nonApplicableAuthStatus : ''}`);
                console.log(`  订阅: ${subStatus}`);
                console.log(`  标识: ${idStatus}`);
                console.log(`  设置: ${settingStatus}`);
                console.log(`  统计: ${statsStatus}`);
            }
            console.log('─'.repeat(40));
        });
        const fieldCoverageRate = totalApplicableFields > 0 ?
            (totalFieldsPresent / totalApplicableFields * 100).toFixed(1) : 0;
        console.log(`📈 字段覆盖率: ${fieldCoverageRate}%`);
    }

    async validateAccounts(browserInstances, accountQueue) {
        const timeout = 120000; // 毫秒

        // 自定义并发上限
        const desiredConcurrencyLimit = 16;

        // 实际浏览器实例数量
        const browserCount = browserInstances.length;

        // 有效并发数变量
        let effectiveConcurrency;

        // 创建账号-浏览器绑定追踪Map
        const accountBrowserMap = new Map();
        const browserAccountMap = new Map();

        // 未分配浏览器账号
        let unassignedAccounts = [];

        // Cookie持久模式下
        if (COOKIE_PERSISTENCE_MODE) {
            if (accountQueue.length > browserCount) {
                console.warn(`Cookie持久模式下：账号数量(${accountQueue.length})超过浏览器实例数量(${browserCount})，将只验证前${browserCount}个账号`);
                const excludedAccounts = accountQueue.slice(browserCount);
                accountQueue = accountQueue.slice(0, browserCount);
                for (const username of excludedAccounts) {
                    delete this.sessions[username];
                    console.log(`已从会话列表中移除账号: ${username} (超出浏览器实例限制)`);
                }
            }

            // 保存所有账号作为未分配初始状态
            unassignedAccounts = [...accountQueue];

            // 最终生效并发总量 = 浏览器实例数量
            effectiveConcurrency = browserCount;
            // 记录账号与浏览器实例绑定
            this.sessionManager.setupAccountBrowserBinding(accountQueue, browserInstances);
        } else {
            // 最终生效的并发总量 = min(浏览器实例数量, 自定义并发上限)
            effectiveConcurrency = Math.min(browserCount, desiredConcurrencyLimit);

            // 如果 Cookie 数量 < 浏览器实例数，则复制到至少 browserCount
            if (accountQueue.length < browserCount) {
                const originalQueue = [...accountQueue];
                if (originalQueue.length === 0) {
                    console.warn("无法验证：accountQueue 为空，未提供任何 Cookie。");
                    return;
                }
                while (accountQueue.length < browserCount) {
                    const randomIndex = Math.floor(Math.random() * originalQueue.length);
                    accountQueue.push(originalQueue[randomIndex]);
                }
                console.log(`队列已扩充到至少与浏览器实例数相同：${accountQueue.length} 条`);
            }

            // 如果队列比"有效并发"小，则再复制到至少 effectiveConcurrency
            if (accountQueue.length < effectiveConcurrency) {
                const originalQueue2 = [...accountQueue];
                while (accountQueue.length < effectiveConcurrency && originalQueue2.length > 0) {
                    const randomIndex = Math.floor(Math.random() * originalQueue2.length);
                    accountQueue.push(originalQueue2[randomIndex]);
                }
                console.log(`队列已扩充到至少并发数：${accountQueue.length} 条 (并发=${effectiveConcurrency})`);
            }
        }

        // 当前正在执行的任务
        const validationPromises = [];

        // 轮询
        let browserIndex = 0;

        function getNextBrowserInstance() {
            const instance = browserInstances[browserIndex];
            browserIndex = (browserIndex + 1) % browserCount;
            return instance;
        }

        while (accountQueue.length > 0) {
            // 如果当前正在执行的任务数量 >= 有效并发
            if (validationPromises.length >= effectiveConcurrency) {
                await Promise.race(validationPromises);
            }

            // 从队列头拿出一个账号
            const currentUsername = accountQueue.shift();

            // Cookie持久模式
            let browserInstance;
            if (COOKIE_PERSISTENCE_MODE) {
                browserInstance = this.sessionManager.getBoundBrowserInstance(currentUsername);
                if (!browserInstance) {
                    console.warn(`未找到与账号 ${currentUsername} 绑定的浏览器实例，跳过验证`);
                    continue;
                }
            } else {
                browserInstance = getNextBrowserInstance();
            }

            const page = browserInstance.page;
            let session = this.sessions[currentUsername];
            let usernameToValidate = currentUsername;

                const validationTask = (async () => {
                try {
                    if (COOKIE_PERSISTENCE_MODE) {
                        try {
                            await page.goto("https://you.com/?chatMode=custom", {
                                timeout,
                                waitUntil: 'domcontentloaded'
                            });
                            // 获取浏览器当前Cookie
                            const currentCookies = await page.cookies();
                            const existingSessionCookie = this.extractSessionCookie(currentCookies);

                            if (existingSessionCookie && existingSessionCookie.email) {
                                const browserEmail = existingSessionCookie.email;

                                if (browserEmail === usernameToValidate) {
                                    // 浏览器缓存与预期账号匹配
                                    console.log(`[${usernameToValidate}] 使用浏览器缓存Cookie信息`);

                                    // 记录账号与绑定
                                    accountBrowserMap.set(browserEmail, browserInstance);
                                    browserAccountMap.set(browserInstance.id, browserEmail);

                                    // 从未分配列表移除
                                    unassignedAccounts = unassignedAccounts.filter(account => account !== browserEmail);

                                    // 合并Cookie到session
                                    const cookieFields = extractCookieFields(existingSessionCookie);
                                    Object.assign(session, cookieFields);
                                    session.authType = existingSessionCookie.authType;
                                    session.isNewVersion = existingSessionCookie.isNewVersion;
                                }
                                else if (this.sessions[browserEmail]) {
                                    const existingBrowserForAccount = accountBrowserMap.get(browserEmail);

                                    if (existingBrowserForAccount && existingBrowserForAccount !== browserInstance) {
                                        console.log(`[${usernameToValidate}] 浏览器缓存账号 ${browserEmail}，该账号已在其他浏览器中缓存`);
                                        await clearCookiesNonBlocking(page);

                                        if (unassignedAccounts.length > 0) {
                                            const newAccountToAssign = unassignedAccounts.shift();
                                            console.log(`[${usernameToValidate}] 为浏览器分配新账号: ${newAccountToAssign}`);

                                            await page.setCookie(...getSessionCookie(extractCookieFields(this.sessions[newAccountToAssign])));

                                            // 更新绑定关系
                                            this.sessionManager.accountBrowserBindings.set(newAccountToAssign, browserInstance);
                                            accountBrowserMap.set(newAccountToAssign, browserInstance);
                                            browserAccountMap.set(browserInstance.id, newAccountToAssign);

                                            // 更新验证目标
                                            usernameToValidate = newAccountToAssign;
                                            session = this.sessions[newAccountToAssign];
                                            await page.reload({ waitUntil: 'domcontentloaded' });
                                        } else {
                                            console.log(`[${usernameToValidate}] 没有未分配账号，保持空闲`);
                                            await page.reload({ waitUntil: 'domcontentloaded' });
                                            return; // 结束此验证任务
                                        }
                                    } else {
                                        console.log(`[${usernameToValidate}] 浏览器缓存了不同账号 (${browserEmail})，验证浏览器缓存`);

                                        // 记录绑定
                                        accountBrowserMap.set(browserEmail, browserInstance);
                                        browserAccountMap.set(browserInstance.id, browserEmail);

                                        // 从未分配列表移除
                                        unassignedAccounts = unassignedAccounts.filter(account => account !== browserEmail);

                                        // 重新加入队列
                                        accountQueue.push(usernameToValidate);

                                        // 更新绑定
                                        this.sessionManager.accountBrowserBindings.set(browserEmail, browserInstance);

                                        // 切换验证
                                        usernameToValidate = browserEmail;
                                        session = this.sessions[browserEmail];

                                        // 合并Cookie到session
                                        const cookieFields = extractCookieFields(existingSessionCookie);
                                        Object.assign(session, cookieFields);
                                        session.authType = existingSessionCookie.authType;
                                        session.isNewVersion = existingSessionCookie.isNewVersion;
                                    }
                                } else {
                                    console.log(`[${usernameToValidate}] 浏览器未知账号 (${browserEmail})，清理Cookie`);

                                    await clearCookiesNonBlocking(page);
                                    await page.setCookie(...getSessionCookie(extractCookieFields(session)));
                                    await page.reload({ waitUntil: 'domcontentloaded' });
                                }
                            } else {
                                console.log(`[${usernameToValidate}] 浏览器中无有效Cookie，使用配置文件中Cookie`);

                                accountBrowserMap.set(usernameToValidate, browserInstance);
                                browserAccountMap.set(browserInstance.id, usernameToValidate);

                                // 从未分配列表中移除
                                unassignedAccounts = unassignedAccounts.filter(account => account !== usernameToValidate);

                                await page.setCookie(...getSessionCookie(extractCookieFields(session)));
                                await page.reload({ waitUntil: 'domcontentloaded' });
                            }
                        } catch (error) {
                            console.warn(`[${usernameToValidate}] Failed to check browser Cookie:`, error);
                            await page.setCookie(...getSessionCookie(extractCookieFields(session)));
                            await page.goto("https://you.com/?chatMode=custom", {
                                timeout,
                                waitUntil: 'domcontentloaded'
                            });
                        }
                        if (validationPromises.length === 1 && unassignedAccounts.length > 0) {
                            const usedBrowserIds = new Set(Array.from(browserAccountMap.keys()));
                            const idleBrowsers = browserInstances.filter(browser => !usedBrowserIds.has(browser.id));

                            if (idleBrowsers.length > 0) {
                                console.log(`${idleBrowsers.length}个空闲浏览器，分配未使用账号`);

                                for (const browser of idleBrowsers) {
                                    if (unassignedAccounts.length === 0) break;

                                    const accountToAssign = unassignedAccounts.shift();
                                    console.log(`分配账号 ${accountToAssign} 到浏览器 ${browser.id}`);

                                    this.sessionManager.accountBrowserBindings.set(accountToAssign, browser);
                                    accountQueue.push(accountToAssign);
                                }
                            }
                        }
                    } else {
                        await page.setCookie(...getSessionCookie(extractCookieFields(session)));
                        await page.goto("https://you.com/?chatMode=custom", {
                            timeout,
                            waitUntil: 'domcontentloaded'
                        });
                    }

                    // 当前任务被提前终止停止验证
                    if (usernameToValidate === null) {
                        return;
                    }

                    try {
                        await page.waitForNetworkIdle({timeout: 5000});
                    } catch (err) {
                        // console.warn(`[${usernameToValidate}] 等待网络空闲超时`);
                    }
                    // 检测是否为 team 账号
                    session.isTeamAccount = await page.evaluate(() => {
                        const teamSelectors = [
                            'div._15zm0ko1 p._15zm0ko2',
                            'div.sc-1a751f3b-0.hyfnxg',
                            'div._108y0xo1 p._108y0xo2',
                            'p:has-text("Your Team")',
                            '[id="teams-navigation-button"]'
                        ];

                        // 检查任一选择器
                        for (const selector of teamSelectors) {
                            try {
                                const element = document.querySelector(selector);
                                if (element) {
                                    // 文本验证
                                    const text = element.textContent?.trim() || '';
                                    if (text.includes('Your Team') || text.includes('Team')) {
                                        return true;
                                    }
                                }
                            } catch (e) {
                                continue;
                            }
                        }

                        if (window.location.pathname.includes('/settings/team')) {
                            return true;
                        }
                        const hasTeamButton = document.querySelector('a[href*="/settings/team-details"]') !== null;
                        const hasTeamNav = document.querySelector('[id*="team"][id*="navigation"]') !== null;

                        return hasTeamButton || hasTeamNav;
                    });

                    // 如果遇到盾了就多等一段时间
                    const pageContent = await page.content();
                    if (pageContent.includes("https://challenges.cloudflare.com")) {
                        console.log(`请在30秒内完成人机验证 (${usernameToValidate})`);
                        await page.evaluate(() => {
                            alert("请在30秒内完成人机验证");
                        });
                        await sleep(30000);
                    }

                    // 验证 cookie 有效性
                    try {
                        const content = await page.evaluate(() => {
                            return fetch("https://you.com/api/user/getYouProState").then(res => res.text());
                        });

                        if (typeof content === 'string') {
                            const contentLower = content.toLowerCase();
                            if (content.includes("User account or domain blocked for abuse")) {
                                console.error(`[${usernameToValidate}] 账号被封禁: ${content}`);
                                await markAccountAsInvalid(usernameToValidate, this.config, "账号或域名因滥用被封禁");
                                session.valid = false;
                                return;
                            } else if (contentLower.includes("blocked")) {
                                console.error(`[${usernameToValidate}] 账号被封禁: ${content}`);
                                await markAccountAsInvalid(usernameToValidate, this.config, "账号被封禁");
                                session.valid = false;
                                return;
                            }
                        }
                        // 解析JSON
                        const json = JSON.parse(content);
                        const allowNonPro = process.env.ALLOW_NON_PRO === "true";

                        // Team账号验证
                        if (json.org_subscriptions && json.org_subscriptions.length > 0) {
                            // 验证是否有有效的Team订阅
                            const validTeamSub = json.org_subscriptions.find(sub =>
                                sub.service === 'youpro_teams' &&
                                sub.is_active === true &&
                                ['active', 'trialing'].includes(sub.status)
                            );

                            if (validTeamSub) {
                                console.log(`${usernameToValidate} 校验成功 -> Team 账号 (${validTeamSub.status})`);
                                session.valid = true;
                                session.isTeam = true;
                                session.isTeamAccount = true;

                                // 存储Team特定信息
                                session.teamDetails = {
                                    tenantId: validTeamSub.tenant_id,
                                    quantity: validTeamSub.quantity,
                                    status: validTeamSub.status,
                                    planName: validTeamSub.plan_name,
                                    interval: validTeamSub.interval,
                                    cancelAtPeriodEnd: validTeamSub.cancel_at_period_end,
                                    currentPeriodEnd: validTeamSub.current_period_end_date
                                };

                                if (!session.youpro_subscription) {
                                    session.youpro_subscription = "true";
                                }

                                // 获取 Team 订阅信息
                                const teamSubscriptionInfo = await this.getTeamSubscriptionInfo(validTeamSub);
                                if (teamSubscriptionInfo) {
                                    session.subscriptionInfo = teamSubscriptionInfo;
                                }
                            } else {
                                console.warn(`${usernameToValidate} 存在组织订阅但无有效Team服务`);
                                session.isTeamAccount = false;
                                session.isTeam = false;
                            }
                        } else if (session.isTeamAccount) {
                            console.warn(`${usernameToValidate} DOM显示Team界面但API无Team订阅数据`);
                            session.isTeamAccount = false;
                            session.isTeam = false;
                        }

                        if (!session.isTeam && Array.isArray(json.subscriptions) && json.subscriptions.length > 0) {
                            console.log(`${usernameToValidate} 校验成功 -> Pro 账号`);
                            session.valid = true;
                            session.isPro = true;

                            if (!session.youpro_subscription) {
                                session.youpro_subscription = "true";
                            }

                            // 获取 Pro 订阅信息
                            const subscriptionInfo = await this.getSubscriptionInfo(page);
                            if (subscriptionInfo) {
                                session.subscriptionInfo = subscriptionInfo;
                            }
                        } else if (!session.isTeam && !session.isPro && allowNonPro) {
                            console.log(`${usernameToValidate} 有效 (非Pro)`);
                            console.warn(`警告: ${usernameToValidate} 没有Pro或Team订阅，功能受限。`);
                            session.valid = true;
                            session.isPro = false;
                            session.isTeam = false;
                        } else if (!session.isTeam && !session.isPro) {
                            console.log(`${usernameToValidate} 无有效订阅`);
                            console.warn(`警告: ${usernameToValidate} 可能没有有效的订阅。请检查You是否有有效的Pro或Team订阅。`);
                            session.valid = false;

                            // 标记为失效
                            await markAccountAsInvalid(usernameToValidate, this.config, "无有效订阅");
                        }
                    } catch (error) {
                        console.log(`${usernameToValidate} 已失效 (fetchYouProState 异常)`);
                        console.warn(`警告: ${usernameToValidate} 验证失败。请检查cookie是否有效。`);

                        if (error instanceof SyntaxError) {
                            console.error(`[${usernameToValidate}] JSON解析错误: ${error.message}`);
                            console.error(`[${usernameToValidate}] 原始响应: ${content}`);
                        } else {
                            console.error(error);
                        }

                        session.valid = false;

                        // 标记为失效
                        await markAccountAsInvalid(usernameToValidate, this.config, "fetchYouProState 异常");
                    }
                } catch (errorVisit) {
                    console.error(`验证账户 ${usernameToValidate} 时出错:`, errorVisit);
                    if (session) {
                        session.valid = false;
                        await markAccountAsInvalid(usernameToValidate, this.config, "API请求失败");
                    }
                } finally {
                    // 如果是多账号模式且不是Cookie持久模式
                    if (!this.isSingleSession && !COOKIE_PERSISTENCE_MODE) {
                        await clearCookiesNonBlocking(page);
                    }
                    const index = validationPromises.indexOf(validationTask);
                    if (index > -1) {
                        validationPromises.splice(index, 1);
                    }
                }
            })();
            validationPromises.push(validationTask);
        }

        // 等待所有任务完成
        await Promise.all(validationPromises);
        if (COOKIE_PERSISTENCE_MODE) {
            // 更新持久化绑定
            for (const [account, browser] of accountBrowserMap) {
                this.sessionManager.accountBrowserBindings.set(account, browser);
            }
            console.log("===== Cookie持久模式账号绑定情况 =====");
            let boundCount = 0;
            for (const [account, browser] of this.sessionManager.accountBrowserBindings) {
                console.log(`账号 ${account} -> 浏览器 ${browser.id}`);
                boundCount++;
            }
            console.log(`总计 ${boundCount} 账号绑定`);

            const boundBrowserIds = new Set(Array.from(this.sessionManager.accountBrowserBindings.values()).map(b => b.id));
            const unboundBrowsers = browserInstances.filter(b => !boundBrowserIds.has(b.id));

            if (unboundBrowsers.length > 0) {
                console.log(` ${unboundBrowsers.length} 浏览器未绑定`);
            }
        }
    }

    async getTeamSubscriptionInfo(subscription) {
        if (!subscription) {
            console.warn('没有有效的Team订阅信息');
            return null;
        }

        const endDate = new Date(subscription.current_period_end_date);
        const today = new Date();
        const daysRemaining = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));

        // 试用状态显示
        const displayStatus = subscription.status === 'trialing' ? '试用中' : subscription.status;

        return {
            expirationDate: endDate.toLocaleDateString('zh-CN', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            }),
            daysRemaining: daysRemaining,
            planName: subscription.plan_name,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            isActive: subscription.is_active,
            status: displayStatus,
            tenantId: subscription.tenant_id,
            quantity: subscription.quantity,
            usedQuantity: subscription.used_quantity || '未提供',
            interval: subscription.interval,
            amount: subscription.amount / 100, // Stripe金额以分为单位
            currency: 'USD', // 假设货币
            provider: subscription.provider,
            isTrial: subscription.status === 'trialing'
        };
    }

    async focusBrowserWindow(title) {
        return new Promise((resolve, reject) => {
            if (process.platform === 'win32') {
                // Windows
                exec(`powershell.exe -Command "(New-Object -ComObject WScript.Shell).AppActivate('${title}')"`, (error) => {
                    if (error) {
                        console.error('无法激活窗口:', error);
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            } else if (process.platform === 'darwin') {
                // macOS
                exec(`osascript -e 'tell application "System Events" to set frontmost of every process whose displayed name contains "${title}" to true'`, (error) => {
                    if (error) {
                        console.error('无法激活窗口:', error);
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            } else {
                // Linux 或其他系统
                console.warn('当前系统不支持自动切换窗口到前台，请手动切换');
                resolve();
            }
        });
    }

    async getSubscriptionInfo(page) {
        try {
            const response = await page.evaluate(async () => {
                const res = await fetch('https://you.com/api/user/getYouProState', {
                    method: 'GET',
                    credentials: 'include'
                });
                return await res.json();
            });
            if (response && response.subscriptions && response.subscriptions.length > 0) {
                const subscription = response.subscriptions[0];
                if (subscription.start_date && subscription.interval) {
                    const startDate = new Date(subscription.start_date);
                    const today = new Date();
                    let expirationDate;

                    // 计算订阅结束日期
                    if (subscription.interval === 'month') {
                        expirationDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, startDate.getDate());
                    } else if (subscription.interval === 'year') {
                        expirationDate = new Date(startDate.getFullYear() + 1, startDate.getMonth(), startDate.getDate());
                    } else {
                        console.log(`未知的订阅间隔: ${subscription.interval}`);
                        return null;
                    }

                    // 计算从开始日期到今天间隔数
                    const intervalsPassed = Math.floor((today - startDate) / (subscription.interval === 'month' ? 30 : 365) / (24 * 60 * 60 * 1000));

                    // 计算到期日期
                    if (subscription.interval === 'month') {
                        expirationDate.setMonth(expirationDate.getMonth() + intervalsPassed);
                    } else {
                        expirationDate.setFullYear(expirationDate.getFullYear() + intervalsPassed);
                    }

                    // 如果计算出的日期仍在过去增加间隔
                    if (expirationDate <= today) {
                        if (subscription.interval === 'month') {
                            expirationDate.setMonth(expirationDate.getMonth() + 1);
                        } else {
                            expirationDate.setFullYear(expirationDate.getFullYear() + 1);
                        }
                    }

                    const daysRemaining = Math.ceil((expirationDate - today) / (1000 * 60 * 60 * 24));

                    return {
                        expirationDate: expirationDate.toLocaleDateString('zh-CN', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                        }),
                        daysRemaining: daysRemaining,
                        planName: subscription.plan_name,
                        cancelAtPeriodEnd: subscription.cancel_at_period_end
                    };
                } else {
                    console.log('订阅信息中缺少 start_date 或 interval 字段');
                    return null;
                }
            } else {
                console.log('API 响应中没有有效的订阅信息');
                return null;
            }
        } catch (error) {
            console.error('获取订阅信息时出错:', error);
            return null;
        }
    }

    async waitForManualLogin(page) {
        return new Promise((resolve, reject) => {
            let isResolved = false; // 标记是否已完成
            let timeoutId;
            let navigationCount = 0;

            // 防止重复通知
            const loginStates = {
                INITIAL: 'initial',
                SIGNING_IN: 'signing_in',
                AUTHENTICATED: 'authenticated'
            };
            let currentLoginState = loginStates.INITIAL;

            // 登录状态
            const checkLoginStatus = async () => {
                try {
                    const loginInfo = await page.evaluate(() => {
                        const newEmailElement = document.querySelector('.vcm2u76.vcm2u74');
                        if (newEmailElement && newEmailElement.textContent.includes('@')) {
                            return newEmailElement.textContent;
                        }
                        // 检测头像元素
                        const avatarElement = document.querySelector('[data-testid="user-profile-avatar"]');
                        if (avatarElement) {
                            return "已登录用户";
                        }

                        // 检查chatMode=custom页面
                        const userInfoElement = document.querySelector('.sc-d107c1c0-0');
                        if (userInfoElement && userInfoElement.textContent &&
                            (userInfoElement.textContent.includes('@') ||
                             userInfoElement.querySelector('[data-testid="user-profile-avatar"]'))) {
                            return "已登录用户";
                        }

                        return null;
                    });

                    // 登录检测
                    if (loginInfo && currentLoginState !== loginStates.AUTHENTICATED) {
                        currentLoginState = loginStates.AUTHENTICATED;
                        console.log(`检测到登录成功: ${loginInfo}`);
                        const cookies = await page.cookies();
                        const sessionCookie = this.extractSessionCookie(cookies);

                        // 设置隐身模式 cookie
                        if (sessionCookie) {
                            await page.setCookie(...sessionCookie);
                            isResolved = true;
                            clearTimeout(timeoutId);
                            resolve({loginInfo, sessionCookie});
                        } else {
                            console.warn('无法提取有效会话Cookie，继续等待...');
                            timeoutId = setTimeout(checkLoginStatus, 1000);
                        }
                    } else {
                        // 检测登录UI状态
                        const loginUIStatus = await page.evaluate(() => {
                            // 标准页面登录链接检测
                            const signInLinks = Array.from(document.querySelectorAll('a'));
                            const hasStandardSignIn = signInLinks.some(link =>
                                link.textContent &&
                                link.textContent.trim() === 'Sign in' &&
                                link.href &&
                                link.href.includes('/signin')
                            );

                            // 检测自定义模式页面按钮
                            const customSignInButton = document.querySelector('[data-testid="sign-in-button"]') ||
                                                     document.querySelector('#login-button');
                            const loginModal = document.querySelector('descope-wc');
                            const currentUrl = window.location.href;
                            const isAuthPage = currentUrl.includes('accounts.google.com') ||
                                              currentUrl.includes('auth.you.com');

                            return {
                                hasStandardSignIn,
                                hasCustomSignInButton: !!customSignInButton,
                                hasLoginModal: !!loginModal,
                                isAuthPage,
                                currentUrl
                            };
                        });

                        // 处理不同登录UI状态
                        if (loginUIStatus.hasStandardSignIn || loginUIStatus.hasCustomSignInButton) {
                            if (currentLoginState !== loginStates.INITIAL) {
                                currentLoginState = loginStates.INITIAL;
                                const btnType = loginUIStatus.hasCustomSignInButton ? '自定义模式登录' : '标准登录';
                                console.log(`[登录过程] 检测到${btnType}，等待操作`);
                            }
                        } else if (loginUIStatus.hasLoginModal) {
                            if (currentLoginState !== loginStates.SIGNING_IN) {
                                currentLoginState = loginStates.SIGNING_IN;
                                console.log(`[登录过程] 检测到登录弹窗，请在弹窗中完成登录`);
                            }
                        } else if (loginUIStatus.isAuthPage) {
                            if (currentLoginState !== loginStates.SIGNING_IN) {
                                currentLoginState = loginStates.SIGNING_IN;
                                console.log(`[登录过程] 检测到认证页面: ${loginUIStatus.currentUrl}`);
                            }
                        }

                        // 继续等待用户操作
                        if (!isResolved) {
                            timeoutId = setTimeout(checkLoginStatus, 1500);
                        }
                    }
                } catch (error) {
                    if (error.message.includes('Execution context was destroyed')) {
                        console.log('页面导航中，等待页面重新加载...');
                    } else {
                        console.error('检查登录状态时出错:', error.message, error.stack);
                        if (!isResolved) {
                            timeoutId = setTimeout(checkLoginStatus, 2000);
                        }
                    }
                }
            };

            // 监听API请求
            page.on('request', async (request) => {
                if (isResolved) return;

                const url = request.url();
                if (url.includes('https://you.com/api/instrumentation') ||
                    url.includes('https://you.com/api/user/getYouProState') ||
                    url.includes('https://you.com/api/custom_assistants/assistants')) {
                    try {
                        const cookies = await page.cookies();
                        const sessionCookie = this.extractSessionCookie(cookies);

                        if (sessionCookie) {
                            await page.setCookie(...sessionCookie);
                            isResolved = true;
                            clearTimeout(timeoutId);
                            resolve({loginInfo: null, sessionCookie});
                        } else {
                            console.warn('无法提取有效Cookie，可能登录未完成');
                        }
                    } catch (error) {
                        console.error('提取Cookie时出错:', error.message, error.stack);
                    }
                }
            });

            page.on('framenavigated', (frame) => {
                if (isResolved || frame !== page.mainFrame()) return;

                navigationCount++;
                console.log(`页面导航 #${navigationCount}: ${frame.url()}`);

                setTimeout(() => {
                    if (!isResolved) {
                        checkLoginStatus();
                    }
                }, 1000);
            });

            page.on('load', () => {
                if (!isResolved) {
                    console.log('页面加载完成，检查登录状态...');
                    setTimeout(checkLoginStatus, 1000);
                }
            });

            checkLoginStatus();

            page.evaluate(() => {
                if (window.location.hostname === 'you.com') {
                    try {
                        // 移除可能存在旧提示
                        const existingPrompt = document.getElementById('you-login-prompt');
                        if (existingPrompt) {
                            existingPrompt.remove();
                        }

                        // 创建提示
                        const div = document.createElement('div');
                        div.id = 'you-login-prompt';
                        div.style.position = 'fixed';
                        div.style.top = '60px';
                        div.style.left = '50%';
                        div.style.transform = 'translateX(-50%)';
                        div.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
                        div.style.color = 'white';
                        div.style.padding = '10px 20px';
                        div.style.borderRadius = '5px';
                        div.style.zIndex = '9999';
                        div.style.fontSize = '14px';

                        const isCustomMode = window.location.href.includes('chatMode=custom');
                        if (isCustomMode) {
                            const loginBtn = document.querySelector('[data-testid="sign-in-button"]') ||
                                            document.querySelector('#login-button');
                            div.textContent = loginBtn
                                ? '请点击"Sign in"按钮登录您的账号'
                                : '请在弹窗中完成登录流程';
                        } else {
                            div.textContent = '请点击"Sign in"登录您的账号';
                        }

                        document.body.appendChild(div);

                        setTimeout(() => div.remove(), 10000); // 10秒自动移除
                        return true;
                    } catch (error) {
                        console.warn(`创建登录提示失败: ${error.message}`);
                        return false;
                    }
                }
                return false;
            }).catch((error) => {
                console.error(`执行页面脚本时出错: ${error.message}`);
            });

            // 设置提醒
            setTimeout(() => {
                if (!isResolved) {
                    console.warn('登录等待超3分钟，请确保正确完成登录流程');

                    page.evaluate(() => {
                        const div = document.createElement('div');
                        div.id = 'you-login-reminder';
                        div.style.position = 'fixed';
                        div.style.top = '50%';
                        div.style.left = '50%';
                        div.style.transform = 'translate(-50%, -50%)';
                        div.style.backgroundColor = 'rgba(220, 0, 0, 0.9)';
                        div.style.color = 'white';
                        div.style.padding = '20px';
                        div.style.borderRadius = '10px';
                        div.style.zIndex = '10000';
                        div.style.fontSize = '18px';
                        div.style.fontWeight = 'bold';
                        div.style.textAlign = 'center';
                        div.innerHTML = '登录等待超3分钟<br>请完成登录或刷新页面重试';
                        document.body.appendChild(div);

                        setTimeout(() => div.remove(), 10000);
                    }).catch(console.error);
                }
            }, 3 * 60 * 1000);
        });
    }

    /**
     * 从浏览器提取cookie
     * @param {Array} cookies 浏览器 cookies
     * @returns {Array|null} 会话 cookie
     */
    extractSessionCookie(cookies) {
        const cookieFields = {};

        // 提取所有已知字段
        for (const cookie of cookies) {
            const fieldName = cookieRegistry.getFieldNameFromCookieName(cookie.name);
            if (fieldName) {
                cookieFields[fieldName] = cookie.value;
            }
        }

        if (!cookieRegistry.isValidSession(cookieFields)) {
            console.error('无法提取有效的会话cookie');
            return null;
        }

        // 创建会话cookie
        const sessionCookie = getSessionCookie(cookieFields);

        // 复制原始提取字段
        Object.assign(sessionCookie, cookieFields);

        // 添加元数据
        if (cookieFields.ds) {
            try {
                const jwt = JSON.parse(Buffer.from(cookieFields.ds.split(".")[1], "base64").toString());
                sessionCookie.email = jwt.email;
                sessionCookie.isNewVersion = true;
                sessionCookie.authType = 'new';  // 标记类型
                if (jwt.tenants) {
                    sessionCookie.tenants = jwt.tenants;
                }
            } catch (error) {
                console.error('解析DS令牌时出错:', error);
            }
        } else if (cookieFields.jwtToken) {
            try {
                const jwt = JSON.parse(Buffer.from(cookieFields.jwtToken.split(".")[1], "base64").toString());
                sessionCookie.email = jwt.user?.email || jwt.email || jwt.user?.name;
                sessionCookie.isNewVersion = false;
                sessionCookie.authType = 'old';  // 标记类型
            } catch (error) {
                console.error('JWT令牌解析错误:', error);
            }
        }

        return sessionCookie;
    }

    /**
     * 隐私配置
     * @param {Object} page
     * @param {string} username
     * @returns {Promise<void>}
     */
    async ensurePrivacySettings(page, username) {
        let shouldUpdate = true;
        try {
            const settings = await page.evaluate(async () => {
                try {
                    const response = await fetch("https://you.com/api/organization/settings", {
                        method: "GET",
                        headers: {"Content-Type": "application/json"}
                    });

                    if (!response.ok) {
                        return { error: `HTTP error: ${response.status}` };
                    }

                    return await response.json();
                } catch (err) {
                    return { error: err.message || "Unknown error" };
                }
            });

            if (settings.error) {
                // console.warn(`[${username}] 获取隐私设置失败: ${settings.error}`);
            } else if (settings.isNoModelTrainingEnabled === true &&
                       settings.isZeroDataRetentionEnabled === true) {
                shouldUpdate = false;
            }
        } catch (error) {
            // console.warn(`[${username}] 隐私设置出错: ${error.message}`);
        }
        if (shouldUpdate) {
            try {
                const updateResult = await page.evaluate(async () => {
                    try {
                        const response = await fetch("https://you.com/api/organization/settings", {
                            method: "PUT",
                            headers: {"Content-Type": "application/json"},
                            body: JSON.stringify({
                                "zdr_enabled": true,
                                "no_model_training_enabled": true
                            })
                        });

                        if (!response.ok) {
                            return { error: `HTTP error: ${response.status}` };
                        }

                        return await response.json();
                    } catch (err) {
                        return { error: err.message || "Unknown error" };
                    }
                });

                if (updateResult.error) {
                    // console.warn(`[${username}] 更新隐私设置失败: ${updateResult.error}`);
                }
            } catch (updateError) {
                // console.error(`[${username}] 更新隐私设置时出错: ${updateError.message}`);
            }
        }
    }

    /**
     * 根据消息内容生成文件名
     * @param {Array} messages
     * @returns {string}
     */
    generateContentBasedFileName(messages) {
        const format = this.uploadFileFormat ? this.uploadFileFormat.toLowerCase() : 'txt';

        if (format === 'txt') {
            // 合并所有消息内容
            let combinedContent = messages
                .map(msg => msg.content || "")
                .join("\n");

            const truncatedContent = combinedContent.substring(0, 35);

            let sanitizedName = "";

            // 保留英文字母、数字、点，其他替换成下划线
            for (const char of truncatedContent) {
                if (/[a-zA-Z0-9.]/.test(char)) {
                    sanitizedName += char;
                } else {
                    sanitizedName += '_';
                }
            }

            if (!sanitizedName || sanitizedName[0] === '.') {
                sanitizedName = 'f_' + sanitizedName;
            }

            const extensionPattern = new RegExp(`\\.${format}$`, 'i');
            if (!extensionPattern.test(sanitizedName)) {
                sanitizedName += `.${format}`;
            }

            return sanitizedName;
        } else {
            // 非txt格式
            const digitCount = Math.floor(Math.random() * 5) + 1;
            const minValue = digitCount === 1 ? 0 : Math.pow(10, digitCount - 1);
            const maxValue = Math.pow(10, digitCount) - 1;
            const randomNumber = Math.floor(Math.random() * (maxValue - minValue + 1)) + minValue;

            let fileName = `message${randomNumber}`;

            const extensionPattern = new RegExp(`\\.${format}$`, 'i');
            if (!extensionPattern.test(fileName)) {
                fileName += `.${format}`;
            }

            return fileName;
        }
    }

    checkAndSwitchMode(session) {
        // 如果当前模式不可用
        if (!session.modeStatus[session.currentMode]) {
            const availableModes = Object.keys(session.modeStatus).filter(mode => session.modeStatus[mode]);

            if (availableModes.length === 0) {
                console.warn("两种模式都达到请求上限。");
            } else if (availableModes.length === 1) {
                session.currentMode = availableModes[0];
                session.rotationEnabled = false;
            }
        }
    }

    async getCompletion({
                            username,
                            messages,
                            browserInstance,
                            stream = false,
                            proxyModel,
                            useCustomMode = false,
                            modeSwitched = false
                        }) {
        if (this.networkMonitor.isNetworkBlocked()) {
            throw new Error("网络异常，请稍后再试");
        }
        const session = this.sessions[username];
        if (!session || !session.valid) {
            throw new Error(`用户 ${username} 的会话无效`);
        }
        const emitter = new EventEmitter();
        let page = browserInstance.page;
        // 初始化 session 相关的模式属性
        if (session.currentMode === undefined) {
            session.currentMode = this.isCustomModeEnabled ? 'custom' : 'default';
            session.rotationEnabled = true;
            session.switchCounter = 0;
            session.requestsInCurrentMode = 0;
            session.lastDefaultThreshold = 0;
            session.switchThreshold = this.getRandomSwitchThreshold(session);
            session.youTotalRequests = 0;
        }
        if (!this.isSingleSession) {
            const today = new Date().toDateString();
            if (session.daily_query_date !== today) {
                session.daily_query_date = today;
                session.daily_query_count = "0"; // 重置
            }
            const cookieFields = extractCookieFields(session);
            const forceRegenUUIDValue = process.env.FORCE_REGEN_UUID;
            let shouldForceRegenUUID = false;
            if (forceRegenUUIDValue && forceRegenUUIDValue.toLowerCase() === 'true') {
                shouldForceRegenUUID = true;
                console.log(`[${username}] Cookie UUID randomization Enabled.`);
            }
            const cookieOptions = {
                currentModel: proxyModel, // 当前请求模型
                forceRegenUUID: shouldForceRegenUUID,
                requestId: uuidV4()
            };
            await page.setCookie(
                ...getSessionCookie(cookieFields, this.config, cookieOptions)
            );
        }

        try {
            if (page.isClosed()) {
                console.warn(`[${username}] 页面关闭，重新创建...`);
            }
            // 模拟历史操作
            await browserHistorySimulator.simulateHistory(page, username);
            await page.goto("https://you.com/?chatMode=custom", {waitUntil: 'domcontentloaded'});
        } catch (err) {
            if (/detached frame/i.test(err.message)) {
                console.warn(`[${username}] 检测到页面 Frame 分离。`);
                try {
                    console.warn(`[${username}] 重试"https://you.com"...`);
                    if (!page.isClosed()) {
                        await page.goto("https://you.com/?chatMode=custom", {waitUntil: 'domcontentloaded'});
                    } else {
                        console.error(`[${username}] 页面被彻底关闭。`);
                    }
                } catch (retryErr) {
                    console.error(`[${username}] 重试 page.goto 失败:`, retryErr);
                    throw retryErr;
                }
            } else {
                throw err;
            }
        }

        // 自动配置隐私设置
        await this.ensurePrivacySettings(page, username);

        //打印messages完整结构
        // console.log(messages);

        // 检查
        if (this.isRotationEnabled) {
            this.checkAndSwitchMode(session);
            if (!Object.values(session.modeStatus).some(status => status)) {
                session.modeStatus.default = true;
                session.modeStatus.custom = true;
                session.rotationEnabled = true;
                console.warn(`账号 ${username} 的两种模式都达到请求上限，重置记录状态。`);
            }
        }
        // 处理模式轮换逻辑
        if (!modeSwitched && this.isCustomModeEnabled && this.isRotationEnabled && session.rotationEnabled) {
            session.switchCounter++;
            session.requestsInCurrentMode++;
            console.log(`当前模式: ${session.currentMode}, 本模式下的请求次数: ${session.requestsInCurrentMode}, 距离下次切换还有 ${session.switchThreshold - session.switchCounter} 次请求`);
            if (session.switchCounter >= session.switchThreshold) {
                this.switchMode(session);
            }
        } else {
            // 检查 messages 中是否包含 -modeid:1 或 -modeid:2
            let modeId = null;
            for (const msg of messages) {
                const match = msg.content.match(/-modeid:(\d+)/);
                if (match) {
                    modeId = match[1];
                    break;
                }
            }
            if (modeId === '1') {
                session.currentMode = 'default';
                console.log(`注意: 检测到 -modeid:1，强制切换到默认模式`);
            } else if (modeId === '2') {
                session.currentMode = 'custom';
                console.log(`注意: 检测到 -modeid:2，强制切换到自定义模式`);
            }
            console.log(`当前模式: ${session.currentMode}`);
        }
        // 根据轮换状态决定是否使用自定义模式
        const effectiveUseCustomMode = this.isRotationEnabled ? (session.currentMode === "custom") : useCustomMode;

        // 检查页面是否已经加载完成
        const isLoaded = await page.evaluate(() => {
            return document.readyState === 'complete' || document.readyState === 'interactive';
        });

        if (!isLoaded) {
            console.log('页面尚未加载完成，等待加载...');
            await page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 10000}).catch(() => {
                console.log('页面加载超时，继续执行');
            });
        }

        // 计算用户消息长度
        let userMessage = [{question: "", answer: ""}];
        let userQuery = "";
        let lastUpdate = true;

        messages.forEach((msg) => {
            if (msg.role === "system" || msg.role === "user") {
                if (lastUpdate) {
                    userMessage[userMessage.length - 1].question += msg.content + "\n";
                } else if (userMessage[userMessage.length - 1].question === "") {
                    userMessage[userMessage.length - 1].question += msg.content + "\n";
                } else {
                    userMessage.push({question: msg.content + "\n", answer: ""});
                }
                lastUpdate = true;
            } else if (msg.role === "assistant") {
                if (!lastUpdate) {
                    userMessage[userMessage.length - 1].answer += msg.content + "\n";
                } else if (userMessage[userMessage.length - 1].answer === "") {
                    userMessage[userMessage.length - 1].answer += msg.content + "\n";
                } else {
                    userMessage.push({question: "", answer: msg.content + "\n"});
                }
                lastUpdate = false;
            }
        });
        userQuery = userMessage[userMessage.length - 1].question;

        const containsTrueRole = messages.some(msg => msg.content.includes(''));

        if (containsTrueRole) {
            if (this.uploadFileFormat === 'docx') {
                console.log(`Detected special string or  in messages, setting USE_BACKSPACE_PREFIX=true and UPLOAD_FILE_FORMAT="txt"`);
                this.uploadFileFormat = 'txt';
                process.env.USE_BACKSPACE_PREFIX = 'true';
            } else {
                console.log(`Detected special string or  in messages, setting USE_BACKSPACE_PREFIX=true and UPLOAD_FILE_FORMAT=${this.uploadFileFormat}`);
                process.env.USE_BACKSPACE_PREFIX = 'true';
            }
        }

        if (containsTrueRole) {
            // 将  从 messages 中移除
            messages = messages.map(msg => ({
                ...msg,
                content: msg.content.replace(/<\|TRUE ROLE\|>/g, '')
            }));
        }

        // 检查并管理session对应模型的user chat mode
        let userChatModeId = "custom";
        // 提取 agentQuery
        const { processedMessages, instructions } = extractAgentInstructions(messages);
        if (instructions) {
            messages = processedMessages;
            console.log(`Extracting system instructions, length: ${instructions.length} characters`);
        }
        if (effectiveUseCustomMode) {
            try {
                if (!this.config.user_chat_mode_id) {
                    this.config.user_chat_mode_id = {};
                }

                // 检查当前用户是否有记录
                if (!this.config.user_chat_mode_id[username]) {
                    this.config.user_chat_mode_id[username] = {};
                    const updatedConfig = JSON.parse(JSON.stringify(this.config));
                    updatedConfig.user_chat_mode_id[username] = {};
                    fs.writeFileSync("./config.mjs", "export const config = " + JSON.stringify(updatedConfig, null, 4));
                    console.log(`Created new record for user: ${username}`);
                }

                if (!this.config.user_chat_mode_id[username][proxyModel] ||
                    !Array.isArray(this.config.user_chat_mode_id[username][proxyModel])) {

                    const existingId = this.config.user_chat_mode_id[username][proxyModel];

                    const updatedConfig = JSON.parse(JSON.stringify(this.config));
                    updatedConfig.user_chat_mode_id[username][proxyModel] = existingId ? [existingId] : [];
                    fs.writeFileSync("./config.mjs", "export const config = " + JSON.stringify(updatedConfig, null, 4));

                    this.config.user_chat_mode_id[username][proxyModel] = existingId ? [existingId] : [];
                    console.log(`Initialized ID array for ${username} model ${proxyModel}`);
                }

                const existingChatModeIds = this.config.user_chat_mode_id[username][proxyModel];
                let deletedIds = [];

                // 删除旧助手
                if (existingChatModeIds.length > 0) {
                    // 获取所有助手列表
                    let allAssistants;
                    try {
                        allAssistants = await page.evaluate(async () => {
                            try {
                                const response = await fetch("https://you.com/api/custom_assistants/assistants?filter_type=all", {
                                    method: "GET",
                                    headers: {"Content-Type": "application/json"}
                                });

                                if (!response.ok) {
                                    return {error: `Failed to get assistant list: ${response.status}`};
                                }

                                return await response.json();
                            } catch (err) {
                                return {error: err.message || "Unknown error"};
                            }
                        });

                        if (allAssistants.error) {
                            console.warn(`Error getting assistant list: ${allAssistants.error}`);
                        }
                    } catch (err) {
                        console.warn(`Exception requesting assistant list: ${err.message}`);
                    }

                    for (const chatModeId of existingChatModeIds) {
                        try {
                            // 检查助手是否存在列表
                            let assistantExists = false;
                            if (allAssistants && !allAssistants.error &&
                                allAssistants.user_chat_modes && Array.isArray(allAssistants.user_chat_modes)) {
                                assistantExists = allAssistants.user_chat_modes.some(
                                    assistant => assistant.chat_mode_id === chatModeId
                                );
                            }

                            if (assistantExists) {
                                // 删除
                                const deleteResult = await page.evaluate(async (id) => {
                                    try {
                                        const response = await fetch("https://you.com/api/custom_assistants/assistants", {
                                            method: "DELETE",
                                            headers: {"Content-Type": "application/json"},
                                            body: JSON.stringify({id})
                                        });

                                        if (!response.ok) {
                                            return {error: `Deletion failed: ${response.status}`};
                                        }

                                        return {success: true};
                                    } catch (err) {
                                        return {error: err.message || "Unknown error"};
                                    }
                                }, chatModeId);

                                if (deleteResult.error) {
                                    console.warn(`Error deleting assistant ${chatModeId}: ${deleteResult.error}`);
                                } else {
                                    deletedIds.push(chatModeId);
                                }
                            } else {
                                console.log(`User ${username}'s assistant ${chatModeId} does not exist or has been deleted`);
                                deletedIds.push(chatModeId);
                            }
                        } catch (err) {
                            console.warn(`Exception processing user ${username}'s assistant ${chatModeId}: ${err.message}`);
                        }
                    }

                    if (deletedIds.length > 0) {
                        // 更新配置
                        this.config.user_chat_mode_id[username][proxyModel] =
                            existingChatModeIds.filter(id => !deletedIds.includes(id));

                        const updatedConfig = JSON.parse(JSON.stringify(this.config));
                        fs.writeFileSync("./config.mjs", "export const config = " + JSON.stringify(updatedConfig, null, 4));
                    }
                }
                // 随机名称
                const formattedProxyModelName = proxyModel.replace(/_/g, ' ');
                const randomDigits = Math.floor(100 + Math.random() * 900).toString();
                const assistantName = `${formattedProxyModelName} ${randomDigits.substring(0, Math.floor(Math.random() * 3) + 1)}`; // 随机取1-3位数字

                const userChatMode = await page.evaluate(
                    async (proxyModel, assistantName, agentInstructions) => {
                        try {
                            const response = await fetch("https://you.com/api/custom_assistants/assistants", {
                                method: "POST",
                                body: JSON.stringify({
                                    aiModel: proxyModel,                // 模型
                                    name: assistantName,                // 助手名称
                                    instructions: agentInstructions,     // 系统指令
                                    instructionsSummary: "",            // 指令摘要说明
                                    isUserOwned: true,                  // 用户拥有标识, true=标识该助手由用户拥有
                                    visibility: "private",              // 可见性设置, private（私有）或 public（公开）
                                    hideInstructions: false,            // 是否在界面上隐藏指令
                                    teams: [],                          // 助手所属的团队列表
                                    hasLiveWebAccess: false,             // 网络访问, true=启用 false=关闭
                                    hasPersonalization: false,          // 个性化功能
                                    includeFollowUps: false,            // 是否包含后续问题或建议
                                    advancedReasoningMode: "off",       // 高级推理模式：可设置为 "auto" 或 "off"
                                    sources: [],                        // 添加附件
                                    webAccessConfig: {                  // 网络访问配置
                                        isWebSearchEnabled: false,       // 是否启用网络搜索
                                        excludedUrls: [],                // 排除的URL列表
                                        searchDepth: "dynamic"           // 搜索深度
                                    }
                                }),
                                headers: {"Content-Type": "application/json"},
                            });

                            if (!response.ok) {
                                return {error: `HTTP error: ${response.status}`};
                            }

                            return await response.json();
                        } catch (err) {
                            return {error: err.message || 'Unknown error'};
                        }
                    },
                    proxyModel,
                    assistantName,
                    instructions
                );

                if (userChatMode && userChatMode.chat_mode_id) {
                    this.config.user_chat_mode_id[username][proxyModel].push(userChatMode.chat_mode_id);

                    const updatedConfig = JSON.parse(JSON.stringify(this.config));
                    fs.writeFileSync("./config.mjs", "export const config = " + JSON.stringify(updatedConfig, null, 4));

                    console.log(`Successfully created new assistant for ${username}: ${userChatMode.chat_mode_id} with name "${assistantName}"`);
                    userChatModeId = userChatMode.chat_mode_id;
                } else {
                    const errorMsg = userChatMode?.error || 'Missing chat_mode_id in response';
                    console.warn(`Failed to create custom assistant for user ${username}: ${errorMsg}`);
                    if (this.config.user_chat_mode_id[username][proxyModel].length > 0) {
                        userChatModeId = this.config.user_chat_mode_id[username][proxyModel][
                        this.config.user_chat_mode_id[username][proxyModel].length - 1
                            ];
                        console.log(`Using ${username}'s existing most recent assistant ID: ${userChatModeId}`);
                    } else {
                        userChatModeId = "custom";
                    }
                }
            } catch (err) {
                console.error(`Error during assistant management for user ${username}: ${err.message}`);
                console.warn("Using default mode.");
                userChatModeId = "custom";
            }
        } else {
            console.log("Custom mode disabled, using default mode.");
            messages = processedMessages;
        }

        // 使用内容创建文件名
        const randomFileName = this.generateContentBasedFileName(messages);
        console.log(`Generated content-based file name: ${randomFileName}`);

        // 试算用户消息长度
        if (encodeURIComponent(JSON.stringify(userMessage)).length + encodeURIComponent(userQuery).length > 32000) {
            console.log("Using file upload mode");

            // 应用格式化逻辑
            const formattedMessages = formatMessages(messages, proxyModel, randomFileName);

            // 将格式化后的消息转换为纯文本
            let previousMessages = formattedMessages
                .map((msg) => {
                    if (!msg.role) {
                        return msg.content;  // role为空只返回content
                    } else {
                        return `${msg.role}: ${msg.content}`;
                    }
                })
                .join("\n\n");

            // 插入乱码（如果启用）
            previousMessages = insertGarbledText(previousMessages);

            // 强制固定第一句话
            if (process.env.FORCE_FILE_UPLOAD_QUERY === 'true') {
                console.log(`Forced first sentence fixed, ignore preset <userQuery>`);
                userQuery = `Please review the attached file: ${randomFileName}`;
                userMessage = [];
            } else {
                userQuery = '';
                // 检测并替换 <userQuery> 标签内容
                ({previousMessages, userQuery} = extractAndReplaceUserQuery(previousMessages, userQuery));

                if (!userQuery) {
                    userQuery = `Please review the attached file: ${randomFileName}`;
                }
                userMessage = [];
            }

            // 创建本地副本（用于调试）
            try {
                const savedPath = this.debugManager.saveDebugMessage(previousMessages);
                const stats = this.debugManager.getStats();
                console.log(`Debug message saved to: ${savedPath}`);
                console.log(`Debug file statistics: ${stats.fileCount}/${this.debugManager.maxFiles} files, total size: ${stats.totalSizeMB} MB`);
            } catch (error) {
                console.error(`Failed to save debug message: ${error.message}`);
                const fallbackPath = path.join(__dirname, 'local_copy_formatted_messages.txt');
                try {
                    fs.writeFileSync(fallbackPath, previousMessages);
                    console.log(`Degraded save to: ${fallbackPath}`);
                } catch (fallbackError) {
                    console.error(`Fallback save failed: ${fallbackError.message}`);
                }
            }

            const result = randomSelect(userQuery);
            userQuery = result.replace(/\${randomFileName}/g, randomFileName);

            // 图片上传逻辑
            const maxImageSizeMB = 5; // 最大允许图片大小限制 (MB)
            // 从 imageStorage 中获取最后一个图片
            var lastImage = imageStorage.getLastImage();
            var uploadedImage = null;
            if (lastImage) {
                const sizeInBytes = Buffer.byteLength(lastImage.base64Data, 'base64');
                const sizeInMB = sizeInBytes / (1024 * 1024);

                if (sizeInMB > maxImageSizeMB) {
                    console.warn(`Image exceeds ${maxImageSizeMB}MB (${sizeInMB.toFixed(2)}MB). Skipping upload.`);
                } else {
                    const fileExtension = lastImage.mediaType.split('/')[1];
                    const fileName = `${lastImage.imageId}.${fileExtension}`;

                    const imageNonce = await getNonceForUpload(page, true);
                    if (!imageNonce) throw new Error("Failed to get nonce for image upload");

                    console.log(`Uploading last image (${fileName}, ${sizeInMB.toFixed(2)}MB)...`);

                    uploadedImage = await page.evaluate(
                        async (base64Data, nonce, fileName, mediaType) => {
                            try {
                                const byteCharacters = atob(base64Data);
                                const byteNumbers = Array.from(byteCharacters, char => char.charCodeAt(0));
                                const byteArray = new Uint8Array(byteNumbers);
                                const blob = new Blob([byteArray], {type: mediaType});

                                const formData = new FormData();
                                formData.append("file", blob, fileName);

                                const response = await fetch("https://you.com/api/upload", {
                                    method: "POST",
                                    headers: {
                                        "X-Upload-Nonce": nonce,
                                    },
                                    body: formData,
                                });
                                const result = await response.json();
                                if (response.ok && result.filename) {
                                    return result; // 包括 filename 和 user_filename
                                } else {
                                    console.error(`Failed to upload image ${fileName}:`, result.error || "Unknown error during image upload");
                                }
                            } catch (e) {
                                console.error(`Failed to upload image ${fileName}:`, e);
                                return null;
                            }
                        },
                        lastImage.base64Data,
                        imageNonce,
                        fileName,
                        lastImage.mediaType
                    );

                    if (!uploadedImage || !uploadedImage.filename) {
                        console.error("Failed to upload image or retrieve filename.");
                        uploadedImage = null;
                    } else {
                        console.log(`Image uploaded successfully: ${fileName}`);

                    }
                    // 清空 imageStorage
                    imageStorage.clearAllImages();
                }
            }

            // 文件上传
            const fileNonce = await getNonceForUpload(page, true);
            if (!fileNonce) throw new Error("Failed to get nonce for file upload");

            var messageBuffer;
            let finalFileName = randomFileName;

            if (this.uploadFileFormat === 'docx') {
                try {
                    // 尝试将 previousMessages 转换
                    messageBuffer = await createDocx(previousMessages);
                    if (!finalFileName.endsWith('.docx')) {
                        finalFileName += '.docx';
                    }
                } catch (error) {
                    console.log("转换docx失败，降级txt格式:", error.message);
                    this.uploadFileFormat = 'txt';
                    // 为 txt 内容添加 BOM
                    const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
                    const contentBuffer = Buffer.from(previousMessages, 'utf8');
                    messageBuffer = Buffer.concat([bomBuffer, contentBuffer]);
                    if (!finalFileName.endsWith('.txt')) {
                        finalFileName += '.txt';
                    }
                }
            } else if (this.uploadFileFormat === 'json') {
                const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
                const contentBuffer = Buffer.from(previousMessages, 'utf8');
                messageBuffer = Buffer.concat([bomBuffer, contentBuffer]);
                // 确保 .json 扩展名
                if (!finalFileName.endsWith('.json')) {
                    finalFileName += '.json';
                }
            } else {
                // txt 格式
                const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF]);
                const contentBuffer = Buffer.from(previousMessages, 'utf8');
                messageBuffer = Buffer.concat([bomBuffer, contentBuffer]);
                if (!finalFileName.endsWith('.txt')) {
                    finalFileName += '.txt';
                }
            }

            if (!messageBuffer || !(messageBuffer instanceof Buffer)) {
                console.error("messageBuffer 无效，创建默认 Buffer");
                messageBuffer = Buffer.from(previousMessages || "", 'utf8');
            }

            const messageBufferArray = Array.from(messageBuffer);

            var uploadedFile = await page.evaluate(
                async (messageBuffer, nonce, fileName, mimeType) => {
                    try {
                        const blob = new Blob([new Uint8Array(messageBuffer)], {type: mimeType});
                        const form_data = new FormData();
                        form_data.append("file", blob, fileName);
                        const resp = await fetch("https://you.com/api/upload", {
                            method: "POST",
                            headers: {"X-Upload-Nonce": nonce},
                            body: form_data,
                        });
                        if (!resp.ok) {
                            console.error('Server returned non-OK status:', resp.status);
                        }
                        return await resp.json();
                    } catch (e) {
                        console.error('Failed to upload file:', e);
                        return null;
                    }
                },
                messageBufferArray, // 使用转换后数组
                fileNonce,
                finalFileName, // 使用扩展名文件名
                this.uploadFileFormat === 'docx'
                    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    : this.uploadFileFormat === 'json'
                        ? "application/json"
                        : "text/plain"
            );
            if (!uploadedFile) {
                console.error("Failed to upload messages or parse JSON response.");
                throw new Error("Upload returned null. Possibly network error or parse error.");
            } else if (uploadedFile.error) {
                throw new Error(uploadedFile.error);
            } else {
                console.log(`Messages uploaded successfully as: ${randomFileName}`);
            }
        }

        let msgid = uuidV4();
        let traceId = uuidV4();
        let finalResponse = ""; // 用于存储最终响应
        let responseStarted = false; // 是否已经开始接收响应
        let responseTimeout = null; // 响应超时计时器
        let customEndMarkerTimer = null; // 自定义终止符计时器
        let customEndMarkerEnabled = false; // 是否启用自定义终止符
        let accumulatedResponse = ''; // 累积响应
        let responseAfter20Seconds = ''; // 20秒后的响应
        let startTime = null; // 开始时间
        const customEndMarker = (process.env.CUSTOM_END_MARKER || '').replace(/^"|"$/g, '').trim(); // 自定义终止符
        let isEnding = false; // 是否正在结束
        const requestTime = new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}); // 请求时间

        let unusualQueryVolumeTriggered = false; // 是否触发了异常请求量提示

        function checkEndMarker(response, marker) {
            if (!marker) return false;
            const cleanResponse = response.replace(/\s+/g, '').toLowerCase();
            const cleanMarker = marker.replace(/\s+/g, '').toLowerCase();
            return cleanResponse.includes(cleanMarker);
        }

        // expose function to receive youChatToken
        // 清理逻辑
        const cleanup = async (skipClearCookies = false) => {
            clearTimeout(responseTimeout);
            clearTimeout(customEndMarkerTimer);
            clearTimeout(errorTimer);
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
            await page.evaluate((traceId) => {
                if (window["exit" + traceId]) {
                    window["exit" + traceId]();
                }
            }, traceId);
            if (!this.isSingleSession && !skipClearCookies) {
                await clearCookiesNonBlocking(page);
            }
            // 检查请求次数是否达到上限
            if (this.enableRequestLimit && session.youTotalRequests >= this.requestLimit) {
                session.modeStatus.default = false;
                session.modeStatus.custom = false;
                this.sessionManager.recordLimitedAccount(username);  // 记录冷却
            }
        };

        // 缓存
        let buffer = '';
        let heartbeatInterval = null; // 心跳计时器
        let errorTimer = null; // 错误计时器
        let errorCount = 0; // 错误计数器
        const self = this;

        // proxy response
        const req_param = new URLSearchParams();
        req_param.append("page", "1");
        req_param.append("count", "10");
        req_param.append("safeSearch", "Moderate"); // Off|Moderate|Strict
        req_param.append("mkt", "ja-JP");
        req_param.append("enable_worklow_generation_ux", "true");
        req_param.append("domain", "youchat");
        req_param.append("use_personalization_extraction", "true");
        req_param.append("queryTraceId", traceId);
        req_param.append("chatId", traceId);
        req_param.append("conversationTurnId", msgid);
        req_param.append("pastChatLength", userMessage.length.toString());
        req_param.append("selectedChatMode", userChatModeId);
        if (uploadedFile || uploadedImage) {
            const sources = [];
            if (uploadedImage) {
                sources.push({
                    source_type: "user_file",
                    user_filename: uploadedImage.user_filename,
                    filename: uploadedImage.filename,
                    size_bytes: Buffer.byteLength(lastImage.base64Data, 'base64'),
                });
            }
            if (uploadedFile) {
                sources.push({
                    source_type: "user_file",
                    user_filename: randomFileName,
                    filename: uploadedFile.filename,
                    size_bytes: messageBuffer.length,
                });
            }
            req_param.append("sources", JSON.stringify(sources));
        }
        req_param.append("search_additional_sources", "true");
        req_param.append("search_depth", "dynamic");
        if (userChatModeId === "custom") req_param.append("selectedAiModel", proxyModel);
        req_param.append("traceId", `${traceId}|${msgid}|${new Date().toISOString()}`);
        req_param.append("use_nested_youchat_updates", "false");
        req_param.append("enable_agent_clarification_questions", "true")
        const url = "https://you.com/api/streamingSearch?" + req_param.toString();
        const enableDelayLogic = process.env.ENABLE_DELAY_LOGIC === 'true'; // 是否启用延迟逻辑
        // 输出 userQuery
        // console.log(`User Query: ${userQuery}`);
        if (enableDelayLogic) {
            await page.goto(`https://you.com/search?q=&fromSearchBar=true&tbm=youchat&chatMode=${userChatModeId}&cid=c0_${traceId}`, {waitUntil: 'domcontentloaded'});
        }

        // 检查连接状态和盾拦截
        async function checkConnectionAndCloudflare(page, url, userQuery, userMessageJson, timeout = 60000) {
            try {
                const response = await Promise.race([
                    page.evaluate(async (url, query, chat) => {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 50000);
                        try {
                            const res = await fetch(url, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Accept': 'text/event-stream'
                                },
                                body: JSON.stringify({
                                    query: query,
                                    chat: chat
                                }),
                                signal: controller.signal
                            });
                            clearTimeout(timeoutId);
                            // 读取响应的前几个字节，确保连接已经建立
                            const reader = res.body.getReader();
                            const {done} = await reader.read();
                            if (!done) {
                                await reader.cancel();
                            }
                            return {
                                status: res.status,
                                headers: Object.fromEntries(res.headers.entries())
                            };
                        } catch (error) {
                            if (error.name === 'AbortError') {
                                throw new Error('Request timed out');
                            }
                            throw error;
                        }
                    }, url, userQuery, userMessageJson),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Evaluation timed out')), timeout))
                ]);

                if (response.status === 403 && response.headers['cf-chl-bypass']) {
                    return {connected: false, cloudflareDetected: true};
                }
                return {connected: true, cloudflareDetected: false};
            } catch (error) {
                console.error("Connection check error:", error);
                return {connected: false, cloudflareDetected: false, error: error.message};
            }
        }

        // 延迟发送请求并验证连接的函数
        async function delayedRequestWithRetry(maxRetries = 2, totalTimeout = 120000) {
            const startTime = Date.now();
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                if (Date.now() - startTime > totalTimeout) {
                    console.error("总体超时，连接失败");
                    emitter.emit("error", new Error("Total timeout reached"));
                    return false;
                }

                if (enableDelayLogic) {
                    await new Promise(resolve => setTimeout(resolve, 5000)); // 5秒延迟
                    console.log(`尝试发送请求 (尝试 ${attempt}/${maxRetries})`);

                    const {connected, cloudflareDetected, error} = await checkConnectionAndCloudflare(
                        page,
                        url,
                        userQuery,
                        JSON.stringify(userMessage)
                    );

                    if (connected) {
                        console.log("连接成功，准备唤醒浏览器");
                        try {
                            // 唤醒浏览器
                            await page.evaluate(() => {
                                window.scrollTo(0, 100);
                                window.scrollTo(0, 0);
                                document.body?.click();
                            });
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            console.log("开始发送请求");
                            emitter.emit("start", traceId);
                            return true;
                        } catch (wakeupError) {
                            console.error("浏览器唤醒失败:", wakeupError);
                            emitter.emit("start", traceId);
                            return true;
                        }
                    } else if (cloudflareDetected) {
                        console.error("检测到 Cloudflare 拦截");
                        emitter.emit("error", new Error("Cloudflare challenge detected"));
                        return false;
                    } else {
                        console.log(`连接失败，准备重试 (${attempt}/${maxRetries}). 错误: ${error || 'Unknown'}`);
                    }
                } else {
                    console.log("开始发送请求");
                    emitter.emit("start", traceId);
                    return true;
                }
            }
            console.error("达到最大重试次数，连接失败");
            emitter.emit("error", new Error("Failed to establish connection after maximum retries"));
            return false;
        }

        async function setupEventSource(page, url, traceId, customEndMarker, shouldDeleteChat, userQuery, userMessageJson) {
            await page.evaluate(
                async (url, traceId, customEndMarker, deleteChatImmediately, query, chat, enableThinking) => {
                    const callbackName = "callback" + traceId;
                    if (typeof window[callbackName] !== 'function') {
                        console.error(`Callback function ${callbackName} is not defined!`);
                        return;
                    }

                    let isEnding = false;
                    let customEndMarkerTimer = null;

                    // CoT状态跟踪
                    const thinkingState = {
                        thinkingStarted: false,    // CoT是否开始
                        thinkingBlockOpen: false,  // CoT是否处于打开状态
                        firstTokenReceived: false  // 是否收到第一个响应
                    };

                    function extractErrorInfo(error) {
                        const errorInfo = {
                            type: "UNKNOWN_ERROR",
                            message: "未知错误",
                            details: {}
                        };

                        try {
                            if (error instanceof ProgressEvent) {
                                if (error.type) {
                                    errorInfo.type = error.type.toUpperCase() + "_ERROR";
                                }

                                if (error.target && error.target.status) {
                                    errorInfo.message = `HTTP错误: ${error.target.status}`;
                                    errorInfo.details.status = error.target.status;
                                    errorInfo.details.statusText = error.target.statusText;
                                } else {
                                    if (error.type === 'error') {
                                        errorInfo.message = "网络连接失败";
                                    } else if (error.type === 'timeout') {
                                        errorInfo.message = "请求超时";
                                    } else if (error.type === 'abort') {
                                        errorInfo.message = "请求被中止";
                                    }
                                }

                                if (error.target) {
                                    errorInfo.details.readyState = error.target.readyState;
                                    errorInfo.details.responseURL = error.target.responseURL;
                                }
                            } else if (error instanceof Error) {
                                errorInfo.message = error.message || "Unknown error";
                                errorInfo.details.name = error.name;
                                errorInfo.details.stack = error.stack;
                            } else if (typeof error === 'string') {
                                errorInfo.message = error;
                            } else {
                                const errorString = String(error);
                                if (errorString !== "[object Object]") {
                                    errorInfo.message = errorString;
                                }

                                if (error && typeof error === 'object') {
                                    if (error.message) errorInfo.message = error.message;
                                    if (error.name) errorInfo.details.name = error.name;
                                    if (error.code) errorInfo.details.code = error.code;
                                    if (error.status) errorInfo.details.status = error.status;
                                }
                            }
                        } catch (e) {
                            console.error("Error while extracting error details:", e);
                        }

                        if (errorInfo.message === "[object Object]") {
                            errorInfo.message = "未能提取错误详情";
                        }

                        return errorInfo;
                    }

                    function createStreamParser(capacity = 64 * 1024) { // 64KB 预分配
                        let buffer = new Uint8Array(capacity);
                        let position = 0;
                        let read = 0;

                        return {
                            append(chunk) {
                                // 超出容量动态扩展
                                if (position + chunk.length >= buffer.length) {
                                    const newBuffer = new Uint8Array(buffer.length * 2);
                                    newBuffer.set(buffer);
                                    buffer = newBuffer;
                                }
                                for (let i = 0; i < chunk.length; i++) {
                                    buffer[position++] = chunk.charCodeAt(i);
                                }
                            },
                            readEvent() {
                                // 查找边界
                                let eventEnd = -1;
                                for (let i = read; i < position - 1; i++) {
                                    if (buffer[i] === 10 && buffer[i + 1] === 10) { // \n\n
                                        eventEnd = i;
                                        break;
                                    }
                                }
                                if (eventEnd === -1) return null;
                                // 提取事件
                                const eventData = String.fromCharCode.apply(null,
                                    buffer.subarray(read, eventEnd));

                                read = eventEnd + 2;

                                return eventData;
                            },
                            compact() {
                                // 压缩缓冲区
                                if (read > 0) {
                                    buffer.copyWithin(0, read, position);
                                    position -= read;
                                    read = 0;
                                }
                            }
                        };
                    }

                    function createSSEParser() {
                        // 解析器状态
                        const PARSING_FIELD = 0;
                        const PARSING_VALUE = 1;

                        // 当前状态
                        let state = PARSING_FIELD;
                        let currentField = '';
                        let currentValue = '';
                        let currentEvent = {type: '', data: ''};

                        // 重置状态
                        function resetState() {
                            state = PARSING_FIELD;
                            currentField = '';
                            currentValue = '';
                            currentEvent = {type: '', data: ''};
                        }

                        // 处理字段
                        function processField() {
                            if (currentField === 'event') {
                                currentEvent.type = currentValue.trim();
                            } else if (currentField === 'data') {
                                currentEvent.data = currentValue.trim();
                            }

                            currentField = '';
                            currentValue = '';
                            state = PARSING_FIELD;
                        }

                        return {
                            reset() {
                                resetState();
                            },

                            parse(eventText) {
                                resetState();

                                for (const element of eventText) {
                                    const char = element;

                                    // 处理字段+值之间分隔符
                                    if (char === ':' && state === PARSING_FIELD) {
                                        state = PARSING_VALUE;
                                        continue;
                                    }

                                    // 处理行尾
                                    if (char === '\n') {
                                        processField();
                                        continue;
                                    }

                                    // 处理字段名
                                    if (state === PARSING_FIELD) {
                                        currentField += char;
                                    } else {
                                        // 跳过值前面的空格
                                        if (currentValue.length === 0 && char === ' ') {
                                            continue;
                                        }
                                        currentValue += char;
                                    }
                                }

                                // 确保处理最后一个字段
                                processField();

                                return currentEvent;
                            }
                        };
                    }

                    function createConnectionManager(url, options = {}) {
                        const {maxRetries = 5, initialDelay = 1000, maxDelay = 30000} = options;
                        let retryCount = 0;
                        let consecutiveSuccesses = 0;
                        let lastConnectTime = 0;
                        let connectionHealth = 1.0; // 0.0-1.0 表示连接健康度
                        let hasReceivedData = false; // 是否已经接收到数据

                        return {
                            connect(onData, onError, onComplete) {
                                const xhr = new XMLHttpRequest();
                                lastConnectTime = Date.now();
                                let offset = options.offset || 0;

                                xhr.onprogress = function () {
                                    const now = Date.now();
                                    const data = xhr.responseText.substr(offset);
                                    offset = xhr.responseText.length;

                                    // 更新连接健康度
                                    if (data.length > 0) {
                                        hasReceivedData = true;
                                        consecutiveSuccesses++;
                                        connectionHealth = Math.min(1.0, connectionHealth + 0.1);
                                    }

                                    onData(data, {
                                        time: now - lastConnectTime,
                                        size: data.length,
                                        health: connectionHealth
                                    });
                                };

                                xhr.onerror = function (error) {
                                    const errorInfo = extractErrorInfo(error);

                                    // 降低连接健康度
                                    connectionHealth = Math.max(0.1, connectionHealth - 0.3);
                                    retryCount++;

                                    const baseDelay = initialDelay * Math.pow(1.5, retryCount);
                                    const jitter = Math.random() * 0.3 * baseDelay;
                                    const healthFactor = 2 - connectionHealth;

                                    const delay = Math.min(
                                        maxDelay,
                                        (baseDelay + jitter) * healthFactor
                                    );
                                    const shouldRetry = !hasReceivedData && retryCount < maxRetries;
                                    onError({
                                        errorInfo,
                                        retryCount,
                                        delay,
                                        connectionHealth,
                                        shouldRetry
                                    });

                                    if (shouldRetry) {
                                        setTimeout(() => this.connect(onData, onError, onComplete), delay);
                                    }
                                };

                                xhr.ontimeout = function (event) {
                                    const errorInfo = extractErrorInfo({
                                        type: 'timeout',
                                        message: "请求超时"
                                    });

                                    const shouldRetry = !hasReceivedData && retryCount < maxRetries;

                                    onError({
                                        errorInfo,
                                        retryCount,
                                        delay: initialDelay,
                                        connectionHealth,
                                        shouldRetry
                                    });

                                    if (shouldRetry) {
                                        retryCount++;
                                        setTimeout(() => this.connect(onData, onError, onComplete), initialDelay);
                                    }
                                };

                                xhr.onloadend = function () {
                                    if (xhr.status >= 400) {
                                        const errorInfo = extractErrorInfo({
                                            type: 'http',
                                            message: `HTTP错误: ${xhr.status} ${xhr.statusText}`,
                                            status: xhr.status,
                                            statusText: xhr.statusText
                                        });

                                        onError({
                                            errorInfo,
                                            retryCount,
                                            delay: 0,
                                            connectionHealth,
                                            shouldRetry: false
                                        });
                                    } else {
                                        onComplete();
                                    }
                                };

                                xhr.open('POST', url, true);
                                xhr.setRequestHeader('Content-Type', 'application/json');
                                xhr.setRequestHeader('Accept', 'text/event-stream');
                                xhr.send(JSON.stringify(options.body || {}));

                                return xhr;
                            },

                            resetRetryCount() {
                                retryCount = 0;
                            }
                        };
                    }

                    // 处理SSE块
                    function enhancedHandleSSEChunk(streamParser, eventParser, chunk) {
                        streamParser.append(chunk);

                        let event;
                        while ((event = streamParser.readEvent()) !== null) {
                            const parsedEvent = eventParser.parse(event);
                            // 过滤空事件
                            if (!parsedEvent.type || !parsedEvent.data) continue;

                            try {
                                if (eventCallbacks[parsedEvent.type]) {
                                    eventCallbacks[parsedEvent.type](parsedEvent.data);
                                }
                            } catch (error) {
                                console.error(`Error processing event ${parsedEvent.type}:`, error);
                            }
                        }
                        streamParser.compact();
                    }

                    // 流解析器+事件解析器
                    const streamParser = createStreamParser();
                    const eventParser = createSSEParser();

                    // 事件回调
                    const eventCallbacks = {
                        youChatToken: (data) => {
                            // 检查并关闭思考块(如果打开)
                            if (enableThinking && thinkingState.thinkingBlockOpen && !thinkingState.firstTokenReceived) {
                                window[callbackName]("closeThinking", "");
                                thinkingState.thinkingBlockOpen = false;
                                thinkingState.firstTokenReceived = true;
                            }

                            window[callbackName]("youChatToken", data);

                            if (customEndMarker && !customEndMarkerTimer) {
                                customEndMarkerTimer = setTimeout(() => {
                                    window[callbackName]("customEndMarkerEnabled", "");
                                }, 20000);
                            }
                        },
                        youChatUpdate: (data) => {
                            if (!enableThinking) return;

                            try {
                                const parsedData = typeof data === 'string' ? JSON.parse(data) : data;

                                // 思考开始
                                if (parsedData.msg === "Thinking" && !parsedData.done && !thinkingState.thinkingStarted) {
                                    thinkingState.thinkingStarted = true;
                                    thinkingState.thinkingBlockOpen = true;
                                    window[callbackName]("openThinking", "");
                                }
                                // 思考内容
                                else if (parsedData.t && thinkingState.thinkingBlockOpen) {
                                    window[callbackName]("youChatUpdate", data);
                                }
                            } catch (error) {
                                console.error(`Error processing youChatUpdate event:`, error);
                            }
                        },
                        done: (data) => {
                            // 确保关闭
                            if (enableThinking && thinkingState.thinkingBlockOpen) {
                                window[callbackName]("closeThinking", "");
                                thinkingState.thinkingBlockOpen = false;
                            }
                            window[callbackName]("done", data);
                        }
                    };

                    // 连接管理器
                    const connectionManager = createConnectionManager(url, {
                        maxRetries: 3,
                        body: {query, chat}
                    });

                    // 连接处理
                    const xhr = connectionManager.connect(
                        // 数据回调
                        (chunk, stats) => {
                            if (isEnding) return;

                            if (stats.size > 0) {
                                enhancedHandleSSEChunk(streamParser, eventParser, chunk);
                            }
                        },
                        // 错误回调
                        (errorData) => {
                            if (isEnding) return;
                            const errorMessage = {
                                type: errorData.errorInfo.type,
                                message: errorData.errorInfo.message,
                                timestamp: new Date().toISOString(),
                                willRetry: errorData.shouldRetry,
                                retryCount: errorData.retryCount,
                                retryDelay: errorData.delay
                            };

                            window[callbackName]("error", JSON.stringify(errorMessage));
                            if (!errorData.shouldRetry && errorData.errorInfo.type !== "UNKNOWN_ERROR") {
                                window[callbackName]("connectionError", `连接问题: ${errorData.errorInfo.message}`);
                            }
                        },
                        // 完成回调
                        () => {
                            if (!isEnding) {
                                window[callbackName]("done", "");
                            }
                        }
                    );

                    // 注册退出函数
                    window["exit" + traceId] = () => {
                        isEnding = true;
                        if (xhr && xhr.readyState !== 4) {
                            xhr.abort();
                        }

                        if (customEndMarkerTimer) {
                            clearTimeout(customEndMarkerTimer);
                        }

                        if (deleteChatImmediately) {
                            fetch("https://you.com/api/chat/deleteChat", {
                                method: "DELETE",
                                headers: {"content-type": "application/json"},
                                body: JSON.stringify({chatId: traceId})
                            }).catch(e => console.error("Failed to delete chat:", e));
                        }
                    };
                },
                url,
                traceId,
                customEndMarker,
                process.env.INCOGNITO_MODE !== 'true',
                userQuery,
                userMessageJson,
                process.env.ENABLE_THINKING_CHAIN === 'true'
            );
        }

        const responseTimeoutTimer = (proxyModel === "openai_o1" || proxyModel === "openai_o1_preview" || proxyModel === "claude_3_7_sonnet_thinking") ? 180000 : 120000; // 响应超时时间

        // 重新发送请求
        async function resendPreviousRequest() {
            try {
                // 清理之前的事件
                await cleanup(true);

                // 重置状态
                isEnding = false;
                responseStarted = false;
                startTime = null;
                accumulatedResponse = '';
                responseAfter20Seconds = '';
                buffer = '';
                customEndMarkerEnabled = false;
                clearTimeout(responseTimeout);

                responseTimeout = setTimeout(async () => {
                    if (!responseStarted) {
                        console.log(`${responseTimeoutTimer / 1000}秒内没有收到响应，终止请求`);
                        emitter.emit("completion", traceId, ` (${responseTimeoutTimer / 1000}秒内没有收到响应，终止请求)`);
                        emitter.emit("end", traceId);
                        self.logger.logRequest({
                            email: username,
                            time: requestTime,
                            mode: session.currentMode,
                            model: proxyModel,
                            completed: false,
                            unusualQueryVolume: unusualQueryVolumeTriggered,
                        });
                    }
                }, responseTimeoutTimer);

                if (stream) {
                    heartbeatInterval = setInterval(() => {
                        if (!isEnding && !clientState.isClosed()) {
                            emitter.emit("completion", traceId, `\r`);
                        } else {
                            clearInterval(heartbeatInterval);
                            heartbeatInterval = null;
                        }
                    }, 5000);
                }

                await setupEventSource(
                    page,
                    url,
                    traceId,
                    customEndMarker,
                    process.env.INCOGNITO_MODE !== 'true',
                    userQuery,
                    JSON.stringify(userMessage)
                );

                return true;
            } catch (error) {
                console.error("重新发送请求时发生错误:", error);
                return false;
            }
        }

        try {
            const connectionEstablished = await delayedRequestWithRetry();
            if (!connectionEstablished) {
                return {
                    completion: emitter, cancel: () => {
                    }
                };
            }

            if (!enableDelayLogic) {
                await page.goto(`https://you.com/search?q=&fromSearchBar=true&tbm=youchat&chatMode=${userChatModeId}&cid=c0_${traceId}`, {waitUntil: "domcontentloaded"});
            }

            await page.exposeFunction("callback" + traceId, async (event, data) => {
                if (isEnding) return;

                switch (event) {
                    case "openThinking": {
                        // 开始CoT
                        if (stream) {
                            emitter.emit("completion", traceId, "<think>\n");
                        } else {
                            finalResponse += "<think>\n";
                        }
                        // 输出至控制台
                        process.stdout.write("<think>\n")
                        break;
                    }
                    case "closeThinking": {
                        // 结束CoT
                        if (stream) {
                            emitter.emit("completion", traceId, "\n</think>\n\n");
                        } else {
                            finalResponse += "\n</think>\n\n";
                        }
                        // 输出至控制台
                        process.stdout.write("\n</think>\n\n")
                        break;
                    }
                    case "youChatUpdate": {
                        if (process.env.ENABLE_THINKING_CHAIN === 'true') {
                            let parsedData;
                            if (typeof data === 'string') {
                                parsedData = JSON.parse(data);
                            } else {
                                parsedData = data;
                            }

                            // 思考内容
                            if (parsedData.t) {
                                const thoughtContent = parsedData.t;

                                // 输出至控制台
                                process.stdout.write(thoughtContent);

                                if (stream) {
                                    emitter.emit("completion", traceId, thoughtContent);
                                } else {
                                    finalResponse += thoughtContent;
                                }
                            }
                        }
                        break;
                    }
                    case "youChatToken": {
                        let parsedData;
                        if (typeof data === 'string') {
                            parsedData = JSON.parse(data);
                        } else {
                            parsedData = data;
                        }

                        let tokenContent = parsedData.youChatToken;
                        buffer += tokenContent;

                        if (buffer.endsWith('\\') && !buffer.endsWith('\\\\')) {
                            // 等待下一个字符
                            break;
                        }
                        let processedContent = unescapeContent(buffer);
                        buffer = '';

                        if (!responseStarted) {
                            responseStarted = true;

                            startTime = Date.now();
                            clearTimeout(responseTimeout);
                            // 自定义终止符延迟触发
                            customEndMarkerTimer = setTimeout(() => {
                                customEndMarkerEnabled = true;
                            }, 20000);

                            // 停止
                            if (heartbeatInterval) {
                                clearInterval(heartbeatInterval);
                                heartbeatInterval = null;
                            }
                        }

                        // 重置错误计时器
                        if (errorTimer) {
                            clearTimeout(errorTimer);
                            errorTimer = null;
                        }

                        // 检测 'unusual query volume'
                        if (processedContent.includes('unusual query volume')) {
                            const warningMessage = "您在 you.com 账号的使用已达上限，当前(default/agent)模式已进入冷却期(CD)。请切换模式(default/agent[custom])或耐心等待冷却结束后再继续使用。";
                            emitter.emit("completion", traceId, warningMessage);
                            unusualQueryVolumeTriggered = true; // 更新标志位

                            if (self.isRotationEnabled) {
                                session.modeStatus[session.currentMode] = false;
                                self.checkAndSwitchMode();
                                if (Object.values(session.modeStatus).some(status => status)) {
                                    console.log(`模式达到请求上限，已切换模式 ${session.currentMode}，请重试请求。`);
                                }
                            } else {
                                console.log("检测到请求量异常提示，请求终止。");
                            }
                            isEnding = true;
                            // 终止
                            setTimeout(async () => {
                                await cleanup();
                                emitter.emit("end", traceId);
                            }, 1000);
                            self.logger.logRequest({
                                email: username,
                                time: requestTime,
                                mode: session.currentMode,
                                model: proxyModel,
                                completed: true,
                                unusualQueryVolume: true,
                            });
                            break;
                        }

                        process.stdout.write(processedContent);
                        accumulatedResponse += processedContent;

                        if (Date.now() - startTime >= 20000) {
                            responseAfter20Seconds += processedContent;
                        }

                        if (stream) {
                            emitter.emit("completion", traceId, processedContent);
                        } else {
                            finalResponse += processedContent;
                        }

                        // 检查自定义结束标记
                        if (customEndMarkerEnabled && customEndMarker && checkEndMarker(responseAfter20Seconds, customEndMarker)) {
                            isEnding = true;
                            console.log("检测到自定义终止，关闭请求");
                            setTimeout(async () => {
                                await cleanup();
                                emitter.emit(stream ? "end" : "completion", traceId, stream ? undefined : finalResponse);
                            }, 1000);
                            self.logger.logRequest({
                                email: username,
                                time: requestTime,
                                mode: session.currentMode,
                                model: proxyModel,
                                completed: true,
                                unusualQueryVolume: unusualQueryVolumeTriggered,
                            });
                        }
                        break;
                    }
                    case "customEndMarkerEnabled":
                        customEndMarkerEnabled = true;
                        break;
                    case "done":
                        if (isEnding) return;
                        console.log("请求结束");
                        isEnding = true;
                        await cleanup(); // 清理
                        emitter.emit(stream ? "end" : "completion", traceId, stream ? undefined : finalResponse);
                        self.logger.logRequest({
                            email: username,
                            time: requestTime,
                            mode: session.currentMode,
                            model: proxyModel,
                            completed: true,
                            unusualQueryVolume: unusualQueryVolumeTriggered,
                        });
                        break;
                    case "error": {
                        if (isEnding) return; // 已结束则忽略

                        console.error("请求发生错误", data);
                        if (errorTimer) {
                            clearTimeout(errorTimer);
                        }
                        let errorData = data;
                        if (typeof data === 'string') {
                            try {
                                errorData = JSON.parse(data);
                            } catch (e) {
                                errorData = {message: data + `\n{${e}\n}`};
                            }
                        }

                        console.error(`XHR错误: 类型=${errorData.type || '未知'}, 消息=${errorData.message || data}`);
                        let errorMessage;
                        if (errorData && errorData.type) {
                            switch (errorData.type) {
                                case "ERROR_ERROR":
                                    errorMessage = "// 网络连接错误";
                                    break;
                                case "TIMEOUT_ERROR":
                                    errorMessage = "// 请求超时，服务器响应时间过长";
                                    break;
                                case "HTTP_ERROR":
                                    errorMessage = "// 服务器返回错误状态码";
                                    break;
                                default:
                                    errorMessage = "// 连接中断，未收到服务器响应";
                            }
                        } else {
                            errorMessage = "// 连接中断，未收到服务器响应";
                        }

                        emitter.emit("completion", traceId, errorMessage);
                        finalResponse += ` (${errorMessage})`;

                        isEnding = true;
                        await cleanup();

                        emitter.emit("end", traceId);
                        self.logger.logRequest({
                            email: username,
                            time: requestTime,
                            mode: session.currentMode,
                            model: proxyModel,
                            completed: false,
                            unusualQueryVolume: unusualQueryVolumeTriggered,
                        });
                        break;
                    }
                    case "connectionError": {
                        console.warn("连接警告:", data);
                        if (stream) {
                            emitter.emit("completion", traceId, `\n// ${data}\n`);
                        } else {
                            finalResponse += `\n// ${data}\n`;
                        }
                        break;
                    }
                }
            });

            responseTimeout = setTimeout(async () => {
                if (!responseStarted && !clientState.isClosed()) {
                    console.log(`${responseTimeoutTimer / 1000}秒内没有收到响应，尝试重新发送请求`);
                    const retrySuccess = await resendPreviousRequest();
                    if (!retrySuccess) {
                        console.log("重试请求时发生错误，终止请求");
                        emitter.emit("completion", traceId, new Error("重试请求时发生错误"));
                        emitter.emit("end", traceId);
                        self.logger.logRequest({
                            email: username,
                            time: requestTime,
                            mode: session.currentMode,
                            model: proxyModel,
                            completed: false,
                            unusualQueryVolume: unusualQueryVolumeTriggered,
                        });
                    }
                } else if (clientState.isClosed()) {
                    console.log("客户端已关闭连接，停止重试");
                    await cleanup();
                    emitter.emit("end", traceId);
                    self.logger.logRequest({
                        email: username,
                        time: requestTime,
                        mode: session.currentMode,
                        model: proxyModel,
                        completed: false,
                        unusualQueryVolume: unusualQueryVolumeTriggered,
                    });
                }
            }, responseTimeoutTimer);

            if (stream) {
                heartbeatInterval = setInterval(() => {
                    if (!isEnding && !clientState.isClosed()) {
                        emitter.emit("completion", traceId, `\r`);
                    } else {
                        clearInterval(heartbeatInterval);
                        heartbeatInterval = null;
                    }
                }, 5000);
            }

            // 初始执行 setupEventSource
            await setupEventSource(
                page,
                url,
                traceId,
                customEndMarker,
                process.env.INCOGNITO_MODE !== 'true',
                userQuery,
                JSON.stringify(userMessage)
            );
            session.youTotalRequests = (session.youTotalRequests || 0) + 1; // 增加请求次数
            // 更新本地配置 cookie
            updateLocalConfigCookieByEmailNonBlocking(page);

        } catch (error) {
            console.error("评估过程中出错:", error);
            if (error.message.includes("Browser Disconnected")) {
                console.log("浏览器断开连接，等待网络恢复...");
            } else {
                emitter.emit("error", error);
            }
        }

        const cancel = async () => {
            await page?.evaluate((traceId) => {
                if (window["exit" + traceId]) {
                    window["exit" + traceId]();
                }
            }, traceId).catch(console.error);
        };

        return {completion: emitter, cancel};
    }
}

export default YouProvider;

function unescapeContent(content) {
    // 将 \" 替换为 "
    // content = content.replace(/\\"/g, '"');

    // content = content.replace(/\\n/g, '');

    // 将 \r 替换为空字符
    // content = content.replace(/\\r/g, '');

    // 将 「 和 」 替换为 "
    // content = content.replace(/[「」]/g, '"');

    return content;
}

function extractAndReplaceUserQuery(previousMessages, userQuery) {
    // 匹配 <userQuery> 标签内的内容，作为第一句话
    const userQueryPattern = /<userQuery>([\s\S]*?)<\/userQuery>/;

    const match = previousMessages.match(userQueryPattern);

    if (match) {
        userQuery = match[1].trim();

        previousMessages = previousMessages.replace(userQueryPattern, '');
    }

    return {previousMessages, userQuery};
}

/**
 * 提取 agentQuery
 * @param {Array} messages
 * @returns {Object}
 */
function extractAgentInstructions(messages) {
    const processedMessages = JSON.parse(JSON.stringify(messages));
    let instructions = "";
    // 正则匹配
    const agentQueryPattern = /<agentQuery>([\s\S]*?)<\/agentQuery>/;

    for (let i = processedMessages.length - 1; i >= 0; i--) {
        const message = processedMessages[i];
        if (typeof message.content !== 'string') continue;

        const match = message.content.match(agentQueryPattern);
        if (match) {
            // 提取标签内容
            instructions = match[1].trim();
            // 移除标签内容
            message.content = message.content.replace(agentQueryPattern, '');
            if (!message.content.trim()) {
                processedMessages.splice(i, 1);
            }
            break;
        }
    }
    return { processedMessages, instructions };
}

async function clearCookiesNonBlocking(page) {
    if (!page.isClosed()) {
        try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.send('Network.clearBrowserCache');

            const cookies = await page.cookies('https://you.com');
            for (const cookie of cookies) {
                await page.deleteCookie(cookie);
            }
            console.log('已自动清理 cookie');
            await sleep(4500);
        } catch (e) {
            console.error('清理 Cookie 时出错:', e);
        }
    }
}

function randomSelect(input) {
    return input.replace(/(.*?)/g, (match, options) => {
        const words = options.split('::');
        const randomIndex = Math.floor(Math.random() * words.length);
        return words[randomIndex];
    });
}

/**
 * 账号标记失效并保存
 * @param {string} username - 账号邮箱
 * @param {Object} config - 配置对象
 * @param {string} reason - 失效原因
 */
async function markAccountAsInvalid(username, config, reason = "已失效") {
    if (!config.invalid_accounts) {
        config.invalid_accounts = {};
    }
    config.invalid_accounts[username] = reason;
    try {
        fs.writeFileSync("./config.mjs", `export const config = ${JSON.stringify(config, null, 4)}`);
    } catch (error) {
        console.error(`保存失效账号信息失败:`, error);
    }
}

/**
 * 生成随机 nonce
 * @returns {string}
 */
function generateLocalNonce() {
    // 标准 UUID v4 格式
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ crypto.randomBytes(1)[0] & 15 >> c / 4).toString(16)
    );
}

/**
 * 获取用于上传 nonce，优先使用随机生成
 * @param {Object} page - Puppeteer
 * @param {boolean} useLocalOnly - 是否只使用随机生成 (不调用 API)
 * @returns {Promise<string>} - nonce
 */
async function getNonceForUpload(page, useLocalOnly = false) {
    const useLocal = useLocalOnly || process.env.USE_LOCAL_NONCE === 'true';
    const localNonce = generateLocalNonce();

    if (useLocal) {
        // console.log(`使用生成 nonce: ${localNonce}`);
        return localNonce;
    }

    try {
        const apiNonce = await page.evaluate(() => {
            return fetch("https://you.com/api/get_nonce")
                .then((res) => res.text())
                .catch(() => '');
        });

        if (apiNonce && apiNonce.length > 10) {
            return apiNonce;
        }

        console.warn('API 返回 nonce 无效');
        return localNonce;
    } catch (error) {
        console.warn(`获取 API nonce 失败: ${error.message}`);
        return localNonce;
    }
}
