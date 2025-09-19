/**
 * 认证辅助
 */
window.AuthHelper = {
    /**
     * 获取session ID
     */
    getSessionId() {
        // 从localStorage获取
        const stored = localStorage.getItem('cm_session');
        if (stored) return stored;
        
        // 从cookie获取
        const cookies = document.cookie.split(';');
        for (const cookie of cookies) {
            const [key, value] = cookie.trim().split('=');
            if (key === 'cm_session') {
                return value;
            }
        }
        return null;
    },

    /**
     * 检查认证状态
     */
    checkAuth() {
        const sessionId = this.getSessionId();
        if (!sessionId) {
            window.location.href = '/cookie-manager/auth';
            return false;
        }
        return true;
    },

    /**
     * 添加认证头到fetch
     */
    addAuthHeaders(options = {}) {
        const sessionId = this.getSessionId();
        if (!sessionId) {
            throw new Error('No session ID found');
        }

        if (!options.headers) {
            options.headers = {};
        }
        
        options.headers['X-Session-Id'] = sessionId;
        return options;
    },

    /**
     * 处理401
     */
    handle401(response) {
        if (response.status === 401) {
            localStorage.removeItem('cm_session');
            document.cookie = 'cm_session=; path=/; max-age=0';
            window.location.href = '/cookie-manager/auth';
            return true;
        }
        return false;
    }
};