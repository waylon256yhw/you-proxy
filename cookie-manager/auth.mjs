import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 密钥文件路径
const AUTH_FILE_PATH = path.join(path.dirname(__dirname), '.cookie-manager-auth.json');

// 登录尝试记录
const loginAttempts = new Map();

/**
 * 认证管理器
 */
class AuthManager {
    constructor() {
        this.initialPassword = null;
        this.isFirstTimeSetup = false;
        this.sessions = new Map(); // 存储会话
        this.sessionTimeout = 24 * 60 * 60 * 1000; // 24小时
    }

    /**
     * 初始化认证系统
     */
    async init() {
        try {
            // 检查密钥文件是否存在
            await fs.access(AUTH_FILE_PATH);
            const authData = await this.readAuthFile();
            this.isFirstTimeSetup = !authData.passwordHash;
            
            console.log('[Cookie Manager] 认证系统初始化');
            
            return {
                isFirstTime: false,
                needsSetup: this.isFirstTimeSetup
            };
        } catch (error) {
            console.log('[Cookie Manager] 首次运行，初始化认证系统');
            
            // 生成随机密码
            this.initialPassword = this.generateRandomPassword();
            this.isFirstTimeSetup = true;
            
            // 创建初始配置文件
            await this.saveAuthFile({
                createdAt: new Date().toISOString(),
                passwordHash: null,
                salt: this.generateSalt(),
                settings: {
                    maxLoginAttempts: 5,
                    lockoutDuration: 5 * 60 * 1000, // 5分钟
                    sessionTimeout: this.sessionTimeout
                }
            });
            
            return {
                isFirstTime: true,
                initialPassword: this.initialPassword,
                needsSetup: true
            };
        }
    }

    /**
     * 8位随机密码
     */
    generateRandomPassword() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
        let password = '';
        const randomBytes = crypto.randomBytes(8);
        
        for (let i = 0; i < 8; i++) {
            password += chars[randomBytes[i] % chars.length];
        }
        
        return password;
    }

    /**
     * 生成盐
     */
    generateSalt() {
        return crypto.randomBytes(32).toString('hex');
    }

    /**
     * 哈希
     */
    hashPassword(password, salt) {
        return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    }

    /**
     * 读取认证
     */
    async readAuthFile() {
        try {
            const content = await fs.readFile(AUTH_FILE_PATH, 'utf8');
            return JSON.parse(content);
        } catch (error) {
            throw new Error('读取认证文件失败');
        }
    }

    /**
     * 保存认证
     */
    async saveAuthFile(data) {
        try {
            await fs.writeFile(AUTH_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
            throw new Error('保存认证文件失败');
        }
    }

    /**
     * 验证密码
     */
    async verifyPassword(password, clientIp) {
        if (this.isLockedOut(clientIp)) {
            const lockInfo = loginAttempts.get(clientIp);
            const remainingTime = Math.ceil((lockInfo.lockedUntil - Date.now()) / 1000 / 60);
            return {
                success: false,
                error: `账户被锁定，请在 ${remainingTime} 分钟后重试`,
                locked: true
            };
        }

        try {
            const authData = await this.readAuthFile();
            if (!authData.passwordHash) {
                // 验证初始密码
                if (password === this.initialPassword) {
                    return {
                        success: true,
                        needsPasswordChange: true
                    };
                } else {
                    this.recordFailedAttempt(clientIp);
                    return {
                        success: false,
                        error: '密码错误'
                    };
                }
            }
            
            // 验证哈希
            const hashedInput = this.hashPassword(password, authData.salt);
            
            if (hashedInput === authData.passwordHash) {
                // 清除失败记录
                loginAttempts.delete(clientIp);
                return {
                    success: true,
                    needsPasswordChange: false
                };
            } else {
                this.recordFailedAttempt(clientIp);
                const attempts = loginAttempts.get(clientIp);
                const remaining = 5 - attempts.count;
                
                if (remaining === 0) {
                    return {
                        success: false,
                        error: '账户被锁定',
                        locked: true,
                        attemptsRemaining: 0
                    };
                }

                return {
                    success: false,
                    error: `密码错误 (剩余尝试次数: ${remaining})`,
                    attemptsRemaining: remaining
                };
            }
        } catch (error) {
            console.error('验证密码失败:', error);
            return {
                success: false,
                error: '系统错误'
            };
        }
    }

    /**
     * 设置新密码
     */
    async setPassword(newPassword) {
        try {
            const authData = await this.readAuthFile();
            
            // 生成新盐+哈希
            const newSalt = this.generateSalt();
            const passwordHash = this.hashPassword(newPassword, newSalt);
            
            // 更新配置
            authData.salt = newSalt;
            authData.passwordHash = passwordHash;
            authData.updatedAt = new Date().toISOString();
            
            await this.saveAuthFile(authData);
            
            // 清除初始密码
            this.initialPassword = null;
            this.isFirstTimeSetup = false;
            
            return { success: true };
        } catch (error) {
            console.error('设置密码失败:', error);
            return {
                success: false,
                error: '设置密码失败'
            };
        }
    }

    /**
     * 记录失败尝试
     */
    recordFailedAttempt(clientIp) {
        const now = Date.now();
        
        if (!loginAttempts.has(clientIp)) {
            loginAttempts.set(clientIp, {
                count: 1,
                firstAttempt: now,
                lastAttempt: now
            });
        } else {
            const attempts = loginAttempts.get(clientIp);
            attempts.count++;
            attempts.lastAttempt = now;
            if (attempts.count >= 5) {
                attempts.lockedUntil = now + (5 * 60 * 1000); // 5分钟
            }
        }
    }

    /**
     * 是否被锁定
     */
    isLockedOut(clientIp) {
        if (!loginAttempts.has(clientIp)) {
            return false;
        }
        
        const attempts = loginAttempts.get(clientIp);
        
        if (attempts.lockedUntil && attempts.lockedUntil > Date.now()) {
            return true;
        }

        if (attempts.lockedUntil && attempts.lockedUntil <= Date.now()) {
            loginAttempts.delete(clientIp);
        }
        
        return false;
    }

    /**
     * 创建会话
     */
    createSession() {
        const sessionId = crypto.randomBytes(32).toString('hex');
        const expiry = Date.now() + this.sessionTimeout;
        
        this.sessions.set(sessionId, {
            createdAt: Date.now(),
            expiresAt: expiry
        });
        
        // 清理过期会话
        this.cleanupSessions();
        
        return sessionId;
    }

    /**
     * 验证会话
     */
    verifySession(sessionId) {
        if (!sessionId || !this.sessions.has(sessionId)) {
            return false;
        }
        
        const session = this.sessions.get(sessionId);
        
        if (session.expiresAt < Date.now()) {
            this.sessions.delete(sessionId);
            return false;
        }
        
        // 更新会话过期时间
        session.expiresAt = Date.now() + this.sessionTimeout;
        
        return true;
    }

    /**
     * 销毁
     */
    destroySession(sessionId) {
        this.sessions.delete(sessionId);
    }

    /**
     * 清理过期会话
     */
    cleanupSessions() {
        const now = Date.now();
        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.expiresAt < now) {
                this.sessions.delete(sessionId);
            }
        }
    }

    /**
     * 获取初始密码（仅首次使用）
     */
    getInitialPassword() {
        return this.initialPassword;
    }

    /**
     * 获取认证状态
     */
    async getAuthStatus() {
        try {
            const authData = await this.readAuthFile();
            return {
                isConfigured: !!authData.passwordHash,
                createdAt: authData.createdAt,
                updatedAt: authData.updatedAt
            };
        } catch {
            return {
                isConfigured: false
            };
        }
    }
}

export const authManager = new AuthManager();

/**
 * Express中间件
 */
export function requireAuth(req, res, next) {
    // 排除认证路由和静态资源
    const publicPaths = [
        '/cookie-manager/auth',
        '/cookie-manager/auth/login',
        '/cookie-manager/auth/setup',
        '/cookie-manager/auth/verify',
        '/cookie-manager/auth/change-password',
        '/cookie-manager/static/'
    ];
    
    // 检查是否是公开路径
    const isPublicPath = publicPaths.some(path => {
        if (path.endsWith('/')) {
            return req.path.startsWith(path);
        } else {
            return req.path === path;
        }
    });

    if (isPublicPath) {
        return next();
    }
    
    // 检查会话
    const sessionId = req.headers['x-session-id'] || 
                     req.query.session ||
                     getCookieValue(req.headers.cookie, 'cm_session');
    
    if (!sessionId || !authManager.verifySession(sessionId)) {
        if (req.path.startsWith('/cookie-manager/api/')) {
            // 清除无效session cookie
            res.setHeader('Set-Cookie', 'cm_session=; Path=/; Max-Age=0');
            return res.status(401).json({
                success: false,
                error: '未授权访问',
                needsAuth: true
            });
        }

        // 页面重定向到登录
        res.setHeader('Set-Cookie', 'cm_session=; Path=/; Max-Age=0');
        return res.redirect('/cookie-manager/auth');
    }
    res.setHeader('X-Session-Valid', 'true');
    next();
}

/**
 * cookie获取值
 */
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