/**
 * API求封装
 */
class API {
    static async request(url, options = {}) {
        const startTime = performance.now();
        const requestId = Math.random().toString(36).slice(2, 11);

        console.info(`[Network] API Request ${requestId}`, {
            url,
            method: options.method || 'GET',
            body: options.body
        });

        try {
            const response = await fetch(url, {
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                },
                ...options
            });

            const data = await response.json();
            const duration = performance.now() - startTime;

            console.info(`[Network] API Response ${requestId}`, {
                status: response.status,
                success: data.success,
                duration: `${duration.toFixed(2)}ms`,
                data: data
            });

            if (!response.ok || !data.success) {
                console.error(`[Network] API Error ${requestId}`, {
                    error: data.error,
                    status: response.status
                });
                throw new Error(data.error || '求失败');
            }

            return data;
        } catch (error) {
            const duration = performance.now() - startTime;
            console.error(`[Network] API Failed ${requestId}`, {
                error: error.message,
                duration: `${duration.toFixed(2)}ms`
            });
            throw error;
        }
    }

    static async getSessions() {
        return this.request('/cookie-manager/api/sessions');
    }

    static async validateCookie(cookie) {
        return this.request('/cookie-manager/api/sessions/validate', {
            method: 'POST',
            body: JSON.stringify({cookie})
        });
    }

    static async addSession(cookie) {
        return this.request('/cookie-manager/api/sessions', {
            method: 'POST',
            body: JSON.stringify({cookie})
        });
    }

    static async batchAddSessions(cookies) {
        return this.request('/cookie-manager/api/sessions/batch', {
            method: 'POST',
            body: JSON.stringify({cookies})
        });
    }

    static async updateSession(index, cookie) {
        return this.request(`/cookie-manager/api/sessions/${index}`, {
            method: 'PUT',
            body: JSON.stringify({cookie})
        });
    }

    static async deleteSession(index) {
        return this.request(`/cookie-manager/api/sessions/${index}`, {
            method: 'DELETE'
        });
    }

    static async batchDeleteSessions(indices) {
        return this.request('/cookie-manager/api/sessions/batch-delete', {
            method: 'POST',
            body: JSON.stringify({indices})
        });
    }

    static async updateInvalidStatus(email, status) {
        return this.request('/cookie-manager/api/invalid-status', {
            method: 'POST',
            body: JSON.stringify({email, status})
        });
    }

    static async batchUpdateStatus(emails, status) {
        return this.request('/cookie-manager/api/batch-status', {
            method: 'POST',
            body: JSON.stringify({ emails, status })
        });
    }
}