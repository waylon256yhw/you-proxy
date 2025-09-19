import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';
import {cookieDebugger} from './debugger.mjs';
import {authManager, requireAuth} from './auth.mjs';
import { setupRestartAPI } from './restart-api.mjs';
import configRouter from './config-api.mjs';
import { setupTerminalAPI } from './terminal-api.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// 中间件
router.use(express.json());
router.use(express.urlencoded({extended: true}));

// 初始化认证系统
const authInfo = { value: null };
(async () => {
    authInfo.value = await authManager.init();
    if (authInfo.isFirstTime) {
        console.log('\n========================================');
        console.log('Cookie Manager 首次运行');
        console.log('初始密码：', authInfo.initialPassword);
        console.log('========================================\n');
    }
})();

router.use('/static', express.static(path.join(__dirname, 'static'), {
    setHeaders: (res, path) => {
        if (path.endsWith('.js') || path.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// 认证路由
router.get('/auth', (req, res) => {
    // 清除可能存在无效session cookie
    res.setHeader('Set-Cookie', 'cm_session=; Path=/; Max-Age=0');
    res.sendFile(path.join(__dirname, 'auth-page.html'));
});

router.post('/auth/verify', async (req, res) => {
    const { password } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const result = await authManager.verifyPassword(password, clientIp);

    if (result.success) {
        const sessionId = authManager.createSession();
        res.json({
            success: true,
            sessionId,
            needsPasswordChange: result.needsPasswordChange
        });
    } else {
        res.json(result);
    }
});

router.post('/auth/change-password', async (req, res) => {
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
        return res.json({
            success: false,
            error: '密码长度至少为8位'
        });
    }

    const result = await authManager.setPassword(newPassword);
    res.json(result);
});

router.post('/auth/logout', (req, res) => {
    const sessionId = req.headers['x-session-id'] ||
                     req.query.session ||
                     getCookieValue(req.headers.cookie, 'cm_session');

    if (sessionId) {
        authManager.destroySession(sessionId);
    }

    // 清除cookie
    res.setHeader('Set-Cookie', 'cm_session=; Path=/; Max-Age=0');
    res.json({ success: true });
});

// 应用认证中间件
router.use(requireAuth);

// 配置文件路径
const CONFIG_PATH = path.join(path.dirname(__dirname), 'config.mjs');

/**
 * 配置文件
 */
class ConfigManager {
    static async read() {
        try {
            cookieDebugger.log('Config', 'Reading config file');
            const configUrl = pathToFileURL(CONFIG_PATH).href;
            const module = await import(`${configUrl}?t=${Date.now()}`);
            cookieDebugger.log('Config', 'Config loaded successfully');
            return module.config;
        } catch (error) {
            cookieDebugger.error('Config', 'Failed to read config', error);
            throw new Error('配置文件读取失败');
        }
    }

    static async save(config) {
        try {
            cookieDebugger.log('Config', 'Saving config file');
            const content = `export const config = ${JSON.stringify(config, null, 4)};`;
            await fs.writeFile(CONFIG_PATH, content, 'utf8');
            cookieDebugger.log('Config', 'Config saved successfully');
            return true;
        } catch (error) {
            cookieDebugger.error('Config', 'Failed to save config', error);
            throw new Error('配置文件保存失败');
        }
    }
}

/**
 * Cookie解析
 */
class CookieParser {
    static parseFields(cookieString) {
        const fields = {};
        const pairs = cookieString.split(/;\s*/);

        for (const pair of pairs) {
            const eqIndex = pair.indexOf('=');
            if (eqIndex > 0) {
                const key = pair.substring(0, eqIndex).trim();
                fields[key] = pair.substring(eqIndex + 1).trim();
            }
        }

        cookieDebugger.log('Cookie', 'Parsed cookie fields', {count: Object.keys(fields).length});
        return fields;
    }

    /**
     * 从Cookie字段提取邮箱
     */
    static extractEmail(cookieFields) {
        try {
            const dsToken = cookieFields.DS || cookieFields.ds;
            if (!dsToken) {
                cookieDebugger.log('Cookie', 'No DS token found');
                return null;
            }

            const parts = dsToken.split('.');
            if (parts.length >= 2) {
                const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
                cookieDebugger.debugJWT(dsToken);
                return payload.email || null;
            }
        } catch (error) {
            cookieDebugger.error('Cookie', 'Failed to extract email', error);
        }
        return null;
    }

    /**
     * 验证Cookie有效性
     */
    static validate(cookieString) {
        const fields = this.parseFields(cookieString);
        const email = this.extractEmail(fields);

        const result = {
            isValid: !!(fields.ds || fields.DS) && !!email,
            email: email,
            hasDs: !!(fields.ds || fields.DS),
            hasDsr: !!(fields.dsr || fields.DSR),
            fields: cookieDebugger.enabled ? fields : undefined
        };

        cookieDebugger.log('Cookie', 'Validation result', result);
        return result;
    }
}

// 静态文件服务
router.use('/static', express.static(path.join(__dirname, 'static')));

// 主页面
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API路由
/**
 * 获取所有sessions
 */
router.get('/api/sessions', async (req, res) => {
    try {
        const config = await ConfigManager.read();
        const sessions = config.sessions || [];

        const enhancedSessions = sessions.map((session, index) => {
            const cookieFields = CookieParser.parseFields(session.cookie);
            const email = CookieParser.extractEmail(cookieFields);

            return {
                cookie: session.cookie,
                email: email,
                index: index
            };
        });

        res.json({
            success: true,
            data: {
                sessions: enhancedSessions,
                invalid_accounts: config.invalid_accounts || {},
                user_chat_mode_id: config.user_chat_mode_id || {},
                debug: cookieDebugger.enabled
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 验证Cookie
 */
router.post('/api/sessions/validate', async (req, res) => {
    try {
        const {cookie} = req.body;
        if (!cookie) {
            return res.status(400).json({
                success: false,
                error: 'Cookie不能为空'
            });
        }

        const validation = CookieParser.validate(cookie);

        res.json({
            success: true,
            data: validation
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 添加Session
 */
router.post('/api/sessions', async (req, res) => {
    try {
        const {cookie} = req.body;
        if (!cookie) {
            return res.status(400).json({
                success: false,
                error: 'Cookie不能为空'
            });
        }

        const validation = CookieParser.validate(cookie);
        if (!validation.isValid) {
            return res.status(400).json({
                success: false,
                error: '无效的Cookie格式'
            });
        }

        const config = await ConfigManager.read();
        config.sessions = config.sessions || [];

        // 检查重复
        if (validation.email) {
            const existingSession = config.sessions.find(s => {
                const existingValidation = CookieParser.validate(s.cookie);
                return existingValidation.email === validation.email;
            });

            if (existingSession) {
                return res.status(400).json({
                    success: false,
                    error: `邮箱 ${validation.email} 已存在`
                });
            }
        }

        config.sessions.push({cookie});
        await ConfigManager.save(config);

        res.json({
            success: true,
            message: 'Session添加成功',
            email: validation.email
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 批量添加Sessions
 */
router.post('/api/sessions/batch', async (req, res) => {
    try {
        const {cookies} = req.body;
        if (!Array.isArray(cookies) || cookies.length === 0) {
            return res.status(400).json({
                success: false,
                error: '提供有效的Cookie数组'
            });
        }

        const config = await ConfigManager.read();
        config.sessions = config.sessions || [];

        // 构建映射
        const existingEmails = new Map();
        config.sessions.forEach((s, index) => {
            const validation = CookieParser.validate(s.cookie);
            if (validation.email) {
                existingEmails.set(validation.email, index);
            }
        });

        const results = {
            added: [],
            skipped: [],
            invalid: []
        };

        for (const cookie of cookies) {
            if (!cookie || typeof cookie !== 'string') continue;

            const trimmedCookie = cookie.trim();
            const validation = CookieParser.validate(trimmedCookie);

            if (!validation.isValid) {
                results.invalid.push({cookie: trimmedCookie, reason: '无效格式'});
                continue;
            }

            // 检查重复
            if (validation.email && existingEmails.has(validation.email)) {
                results.skipped.push({cookie: trimmedCookie, email: validation.email});
            } else {
                config.sessions.push({cookie: trimmedCookie});
                results.added.push({cookie: trimmedCookie, email: validation.email});
                if (validation.email) {
                    existingEmails.set(validation.email, config.sessions.length - 1);
                }
            }
        }

        await ConfigManager.save(config);

        res.json({
            success: true,
            message: `成功添加${results.added.length}个，跳过${results.skipped.length}个，无效${results.invalid.length}个`,
            results: results
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 更新Session
 */
router.put('/api/sessions/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const {cookie} = req.body;

        if (!cookie) {
            return res.status(400).json({
                success: false,
                error: 'Cookie不能为空'
            });
        }

        const validation = CookieParser.validate(cookie);
        if (!validation.isValid) {
            return res.status(400).json({
                success: false,
                error: '无效的Cookie格式'
            });
        }

        const config = await ConfigManager.read();
        if (!config.sessions || index < 0 || index >= config.sessions.length) {
            return res.status(404).json({
                success: false,
                error: 'Session不存在'
            });
        }

        config.sessions[index].cookie = cookie;
        await ConfigManager.save(config);

        res.json({
            success: true,
            message: 'Session更新成功',
            email: validation.email
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 删除Session
 */
router.delete('/api/sessions/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const config = await ConfigManager.read();

        if (!config.sessions || index < 0 || index >= config.sessions.length) {
            return res.status(404).json({
                success: false,
                error: 'Session不存在'
            });
        }

        // 获取删除的session
        const session = config.sessions[index];
        const cookieFields = CookieParser.parseFields(session.cookie);
        const email = CookieParser.extractEmail(cookieFields);

        // 在invalid_accounts标记`已删除`
        if (email) {
            if (!config.invalid_accounts) {
                config.invalid_accounts = {};
            }
            config.invalid_accounts[email] = '已删除';
        }

        config.sessions.splice(index, 1);
        await ConfigManager.save(config);

        res.json({
            success: true,
            message: 'Session删除成功'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 批量删除Sessions
 */
router.post('/api/sessions/batch-delete', async (req, res) => {
    try {
        const {indices} = req.body;
        if (!Array.isArray(indices) || indices.length === 0) {
            return res.status(400).json({
                success: false,
                error: '提供要删除的索引数组'
            });
        }

        const config = await ConfigManager.read();
        if (!config.invalid_accounts) {
            config.invalid_accounts = {};
        }

        const sortedIndices = indices.sort((a, b) => b - a);

        for (const index of sortedIndices) {
            if (index >= 0 && index < config.sessions.length) {
                // 获取删除的session
                const session = config.sessions[index];
                const cookieFields = CookieParser.parseFields(session.cookie);
                const email = CookieParser.extractEmail(cookieFields);

                // 在invalid_accounts标记`已删除`
                if (email) {
                    config.invalid_accounts[email] = '已删除';
                }

                config.sessions.splice(index, 1);
            }
        }

        await ConfigManager.save(config);

        res.json({
            success: true,
            message: `成功删除${indices.length}个Session`
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 批量更新状态
 */
router.post('/api/batch-status', async (req, res) => {
    try {
        const { emails, status } = req.body;

        if (!Array.isArray(emails) || emails.length === 0) {
            return res.status(400).json({
                success: false,
                error: '提供有效的邮箱列表'
            });
        }

        cookieDebugger.log('BatchStatus', 'Processing batch status update', {
            emailCount: emails.length,
            status: status || 'clear'
        });

        const config = await ConfigManager.read();
        if (!config.invalid_accounts) {
            config.invalid_accounts = {};
        }

        let updatedCount = 0;

        emails.forEach(email => {
            if (email && email !== '未知') {
                if (status) {
                    // 设置状态
                    config.invalid_accounts[email] = status;
                } else {
                    // 清除状态
                    delete config.invalid_accounts[email];
                }
                updatedCount++;
            }
        });

        await ConfigManager.save(config);

        cookieDebugger.log('BatchStatus', 'Batch status update completed', {
            updated: updatedCount
        });

        res.json({
            success: true,
            message: `成功更新 ${updatedCount} 个账号的状态`,
            updated: updatedCount
        });
    } catch (error) {
        cookieDebugger.error('BatchStatus', 'Failed to update batch status', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 更新无效账号状态
 */
router.post('/api/invalid-status', async (req, res) => {
    try {
        const {email, status} = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                error: '邮箱不能为空'
            });
        }

        const config = await ConfigManager.read();
        if (!config.invalid_accounts) {
            config.invalid_accounts = {};
        }

        if (status) {
            config.invalid_accounts[email] = status;
        } else {
            delete config.invalid_accounts[email];
        }

        await ConfigManager.save(config);

        res.json({
            success: true,
            message: '状态更新成功'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 调试端点 - 仅在调试模式下可用
 */
router.get('/api/debug', async (req, res) => {
    if (!cookieDebugger.enabled) {
        return res.status(404).json({
            success: false,
            error: '调试模式未启用'
        });
    }

    const config = await ConfigManager.read();
    const stats = {
        totalSessions: config.sessions?.length || 0,
        invalidAccounts: Object.keys(config.invalid_accounts || {}).length,
        userChatModes: Object.keys(config.user_chat_mode_id || {}).length,
        debugEnabled: true
    };

    res.json({
        success: true,
        data: stats
    });
});

/**
 * 获取调试状态
 */
router.get('/api/debug/status', async (req, res) => {
    res.json({
        success: true,
        enabled: cookieDebugger.isEnabled()
    });
});

/**
 * 切换调试模式
 */
router.post('/api/debug/toggle', async (req, res) => {
    const newState = cookieDebugger.toggle();

    res.json({
        success: true,
        enabled: newState,
        message: newState ? '调试模式已开启' : '调试模式已关闭'
    });
});

/**
 * 设置调试模式
 */
router.post('/api/debug/set', async (req, res) => {
    const {enabled} = req.body;

    if (enabled) {
        cookieDebugger.enable();
    } else {
        cookieDebugger.disable();
    }

    res.json({
        success: true,
        enabled: cookieDebugger.isEnabled()
    });
});

/**
 * 获取调试日志
 */
router.get('/api/debug/logs', async (req, res) => {
    const {filter} = req.query;
    const logs = cookieDebugger.getLogs(filter);

    res.json({
        success: true,
        logs: logs
    });
});

/**
 * 清空调试日志
 */
router.post('/api/debug/clear', async (req, res) => {
    cookieDebugger.clearLogs();

    res.json({
        success: true,
        message: '日志已清空'
    });
});

// cookie获取值
function getCookieValue(cookieString, name) {
    if (!cookieString) return null;

    const cookies = cookieString.split(';');
    for (const cookie of cookies) {
        const [key, value] = cookie.trim().split('=');
        if (key === name) {
            return value;
        }
    }
    return null;
}

router.use('/api/config', configRouter);
// 设置重启API
setupRestartAPI(router);

export { router as default, authInfo as cookieManagerAuth };

export function setupCookieManagerTerminal(server) {
    setupTerminalAPI(server);
}