/**
 * UI组件和通知系统
 */
class UI {
    static showLoading() {
        const loader = document.getElementById('globalLoader');
        if (loader) loader.classList.add('show');
    }

    static hideLoading() {
        const loader = document.getElementById('globalLoader');
        if (loader) loader.classList.remove('show');
    }

    static showNotification(message, type = 'info', duration = 3000) {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type} notification-enter`;
        notification.innerHTML = `
            <div class="notification-icon">
                <i class="icon-${type}"></i>
            </div>
            <div class="notification-content">${message}</div>
        `;

        const container = document.getElementById('notificationContainer');
        container.appendChild(notification);

        // 动画
        setTimeout(() => notification.classList.add('notification-show'), 10);

        // 自动关闭
        setTimeout(() => {
            notification.classList.remove('notification-show');
            setTimeout(() => notification.remove(), 300);
        }, duration);
    }

    static showSuccess(message) {
        this.showNotification(message, 'success');
    }

    static showError(message) {
        this.showNotification(message, 'error', 5000);
    }

    static showWarning(message) {
        this.showNotification(message, 'warning');
    }

    static showInfo(message) {
        this.showNotification(message, 'info');
    }

    static async confirm(message) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'modal show';
            modal.innerHTML = `
                <div class="modal-wrapper">
                    <div class="modal-content modal-confirm">
                        <div class="modal-header">
                            <h2>确认操作</h2>
                        </div>
                        <div class="modal-body">
                            <p>${message}</p>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-primary" onclick="UI.confirmResolve(true)">确认</button>
                            <button class="btn btn-secondary" onclick="UI.confirmResolve(false)">取消</button>
                        </div>
                    </div>
                </div>
            `;

            UI.confirmResolve = (result) => {
                modal.remove();
                document.body.classList.remove('modal-open');
                resolve(result);
            };

            document.body.appendChild(modal);
            document.body.classList.add('modal-open');
        });
    }

    static showEmailList(emails) {
        const modal = document.createElement('div');
        modal.className = 'modal show';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2>邮箱列表</h2>
                    <span class="close" onclick="this.closest('.modal').remove(); document.body.classList.remove('modal-open')">&times;</span>
                </div>
                <div class="modal-body">
                    <textarea class="email-list" readonly>${emails.join('\n')}</textarea>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-primary" onclick="UI.copyEmailList(this)">复制</button>
                    <button class="btn btn-secondary" onclick="this.closest('.modal').remove(); document.body.classList.remove('modal-open')">关闭</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        document.body.classList.add('modal-open');
    }

    static async copyEmailList(button) {
        const textarea = button.closest('.modal').querySelector('.email-list');
        try {
            await navigator.clipboard.writeText(textarea.value);
            this.showSuccess('已复制到剪贴板');
        } catch (error) {
            textarea.select();
            document.execCommand('copy');
            this.showSuccess('已复制到剪贴板');
        }
    }
}