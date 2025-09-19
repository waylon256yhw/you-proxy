/**
 * Cookie管理器核心
 */
class CookieManager {
    constructor() {
        this.sessions = [];
        this.invalidAccounts = {};
        this.selectedIndices = new Set();
        this.pendingDeletes = new Set();
        this.debugMode = false;
        this.operationLog = []; // 操作日志
        this.infoLoggingEnabled = false; // 默认关闭INFO记录
        this.networkLoggingEnabled = false; // 默认关闭Network记录
        this.refreshMode = 'auto-scroll'; // 默认自动刷新+滚动
        // 分页
        this.currentPage = 1;
        this.pageSize = this.getPageSize() || 10; // 10条
        this.totalPages = 1;
        this.filteredSessions = []; // 过滤后数据
        // 滑动
        this.swipeStartX = 0;
        this.swipeEndX = 0;
        this.swipeThreshold = 50; // 滑动阈值
        this.isSwipping = false;
        this.swipeVelocity = 0;

        this.init();
    }

    async init() {
        await this.refreshSessions();
        this.bindEvents();
        await this.checkDebugMode();
        // 监听窗口大小变化，调整调试面板位置
        window.addEventListener('resize', () => {
            this.adjustDebugPanelPosition();
        });
        // 显示滑动提示 (仅首次)
        // if (!localStorage.getItem('cookieManagerSwipeHintShown')) {
        //     setTimeout(() => {
        //         const container = document.querySelector('.table-container');
        //         if (container && this.totalPages > 1) {
        //             container.classList.add('swipe-hint');
        //             localStorage.setItem('cookieManagerSwipeHintShown', 'true');
        //             setTimeout(() => {
        //                 container.classList.remove('swipe-hint');
        //             }, 3000);
        //         }
        //     }, 1000);
        // }
    }

    // 获取保存每页显示数
    getPageSize() {
        const saved = localStorage.getItem('cookieManagerPageSize');
        return saved ? parseInt(saved) : 10;
    }

    // 保存每页显示数
    savePageSize(size) {
        localStorage.setItem('cookieManagerPageSize', size);
    }

    // 操作日志记录
    logOperation(action, details = {}) {
        const operation = {
            action,
            timestamp: new Date().toISOString(),
            details,
            user: 'User'
        };

        this.operationLog.push(operation);

        // 保持最近1000条操作
        if (this.operationLog.length > 1000) {
            this.operationLog.shift();
        }

        if (window.debugLogger && this.infoLoggingEnabled) {
            console.info(`[Operation] ${action}`, details);
        }
    }

    // 调整面板位置
    adjustDebugPanelPosition() {
        const panel = document.querySelector('.debug-panel');
        if (!panel) return;

        const rect = panel.getBoundingClientRect();
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const minVisibleArea = 50;

        let needsAdjustment = false;
        let newX = rect.left;
        let newY = rect.top;

        if (rect.right < minVisibleArea) {
            newX = -panel.offsetWidth + minVisibleArea;
            needsAdjustment = true;
        } else if (rect.left > windowWidth - minVisibleArea) {
            newX = windowWidth - minVisibleArea;
            needsAdjustment = true;
        }

        if (rect.bottom < minVisibleArea) {
            newY = -panel.offsetHeight + minVisibleArea;
            needsAdjustment = true;
        } else if (rect.top > windowHeight - minVisibleArea) {
            newY = windowHeight - minVisibleArea;
            needsAdjustment = true;
        }

        if (needsAdjustment) {
            panel.style.left = `${newX}px`;
            panel.style.top = `${newY}px`;
            this.saveDebugPanelPosition(newX, newY);
        }
    }

    async checkDebugMode() {
        try {
            const response = await fetch('/cookie-manager/api/debug/status');
            const data = await response.json();
            if (data.success) {
                this.debugMode = data.enabled;
                if (this.debugMode) {
                    this.showDebugPanel();
                }
            }
        } catch (error) {
            // 调试接口不可用
            console.error('Failed to check debug status:', error);
        }
    }

    // 调试模式切换
    async toggleDebugMode() {
        this.logOperation('TOGGLE_DEBUG_MODE_START', {
            currentState: this.debugMode
        });

        try {
            const response = await fetch('/cookie-manager/api/debug/toggle', {
                method: 'POST'
            });
            const data = await response.json();

            if (data.success) {
                this.debugMode = data.enabled;
                this.logOperation('TOGGLE_DEBUG_MODE_SUCCESS', {
                    newState: this.debugMode
                });

                UI.showInfo(data.message);

                if (this.debugMode) {
                    this.showDebugPanel();
                } else {
                    // 移除调试面板
                    const panel = document.querySelector('.debug-panel');
                    if (panel) panel.remove();

                    // 取消订阅
                    if (this.debugLogListener && window.debugLogger) {
                        window.debugLogger.unsubscribe(this.debugLogListener);
                    }

                    if (this.backendLogTimer) {
                        clearInterval(this.backendLogTimer);
                    }
                }
            }
        } catch (error) {
            this.logOperation('TOGGLE_DEBUG_MODE_ERROR', {
                error: error.message
            });
            UI.showError('切换调试模式失败');
        }
    }

    bindEvents() {
        // 全选
        document.getElementById('selectAll').addEventListener('change', (e) => {
            this.toggleSelectAll(e.target.checked);
        });

        // 搜索 - 防抖
        let searchTimeout;
        document.getElementById('searchInput').addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.filterSessions(e.target.value);
            }, 100); // 100ms 延迟
        });

        // 键盘快捷键
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + D 切换调试模式
            if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
                e.preventDefault();
                this.toggleDebugMode();
            }
        });

        // 模态框外部点击关闭
        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                this.closeModal(e.target.id);
            }
        });

        // 分页事件
        this.bindPaginationEvents();

        // 视觉反馈
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
            mainContent.addEventListener('scroll', () => {
                const pagination = document.getElementById('paginationContainer');
                if (pagination && pagination.style.display !== 'none') {
                    const rect = pagination.getBoundingClientRect();
                    const isInView = rect.top < window.innerHeight && rect.bottom > 0;

                    if (isInView) {
                        pagination.classList.add('in-view');
                    } else {
                        pagination.classList.remove('in-view');
                    }
                }
            });
        }
    }

    // 绑定分页
    bindPaginationEvents() {
        const tableContainer = document.querySelector('.table-container');

        // 滑动切换页面
        let touchStartX = 0;
        let touchStartTime = 0;

        tableContainer.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartTime = Date.now();
        }, {passive: true});

        tableContainer.addEventListener('touchend', (e) => {
            const touchEndX = e.changedTouches[0].clientX;
            const touchEndTime = Date.now();
            const distance = touchEndX - touchStartX;
            const duration = touchEndTime - touchStartTime;
            const velocity = Math.abs(distance) / duration;

            if (Math.abs(distance) > this.swipeThreshold || velocity > 0.5) {
                if (distance > 0) {
                    this.goToPrevPage();
                } else {
                    this.goToNextPage();
                }
            }
        }, {passive: true});

        // 鼠标滑动支持
        let mouseDown = false;
        let mouseStartX = 0;
        let mouseStartTime = 0;

        tableContainer.addEventListener('mousedown', (e) => {
            if (e.target.closest('button') || e.target.closest('input')) return;

            mouseDown = true;
            mouseStartX = e.clientX;
            mouseStartTime = Date.now();
            tableContainer.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', (e) => {
            if (!mouseDown) return;
            e.preventDefault();
        });

        document.addEventListener('mouseup', (e) => {
            if (!mouseDown) return;

            mouseDown = false;
            tableContainer.style.cursor = '';

            const mouseEndX = e.clientX;
            const mouseEndTime = Date.now();
            const distance = mouseEndX - mouseStartX;
            const duration = mouseEndTime - mouseStartTime;
            const velocity = Math.abs(distance) / duration;

            if (Math.abs(distance) > this.swipeThreshold || velocity > 0.3) {
                if (distance > 0) {
                    this.goToPrevPage();
                } else {
                    this.goToNextPage();
                }
            }
        });

        // 键盘事件
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.goToPrevPage();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.goToNextPage();
            }
        });

        // 跳转输入框回车事件
        document.getElementById('pageJumpInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.jumpToPage();
            }
        });
    }

    async refreshSessions() {
        this.logOperation('REFRESH_SESSIONS_START', {pendingDeletes: this.pendingDeletes.size});

        try {
            UI.showLoading();

            if (this.pendingDeletes.size > 0) {
                this.logOperation('DELETE_PENDING_SESSIONS', {
                    count: this.pendingDeletes.size,
                    indices: Array.from(this.pendingDeletes)
                });

                const indices = Array.from(this.pendingDeletes).sort((a, b) => b - a);
                const response = await API.batchDeleteSessions(indices);

                if (response.success) {
                    this.logOperation('DELETE_SUCCESS', {deletedCount: indices.length});
                    this.pendingDeletes.clear();
                    UI.showSuccess('删除操作已完成');
                } else {
                    this.logOperation('DELETE_FAILED', {error: response.error});
                }
            }

            // 获取最新数据
            const response = await fetch('/cookie-manager/api/sessions');
            const data = await response.json();

            if (data.success) {
                this.logOperation('REFRESH_SUCCESS', {
                    sessionsCount: data.data.sessions.length,
                    invalidCount: Object.keys(data.data.invalid_accounts).length,
                    previousCount: this.sessions.length
                });

                this.sessions = data.data.sessions;
                this.invalidAccounts = data.data.invalid_accounts;
                this.pendingDeletes.clear();
                this.selectedIndices.clear();
                this.render();
                this.updateStats();
                this.updateRefreshButton();
            } else {
                // API错误
                this.logOperation('REFRESH_FAILED', {error: data.error});
                UI.showError('获取数据失败: ' + data.error);
            }
        } catch (error) {
            this.logOperation('REFRESH_ERROR', {
                error: error.message,
                stack: error.stack
            });
            console.error('Error:', error);
            UI.showError('网络错误，重试');
        } finally {
            UI.hideLoading();
        }
    }

    render() {
        const tbody = document.getElementById('sessionsBody');
        tbody.innerHTML = '';

        const dataToRender = this.filteredSessions.length > 0 || this.isSearching
            ? this.filteredSessions
            : this.sessions;

        // 计算分页
        this.totalPages = Math.ceil(dataToRender.length / this.pageSize);

        if (this.currentPage > this.totalPages) {
            this.currentPage = Math.max(1, this.totalPages);
        }

        const startIndex = (this.currentPage - 1) * this.pageSize;
        const endIndex = Math.min(startIndex + this.pageSize, dataToRender.length);

        for (let i = startIndex; i < endIndex; i++) {
            const session = dataToRender[i];
            const originalIndex = this.sessions.indexOf(session);
            const row = this.createSessionRow(session, originalIndex);
            tbody.appendChild(row);
        }

        // 更新分页UI
        this.updatePaginationUI(dataToRender.length);

        // 更新选中状态
        this.updateSelectAllState();
    }

    // 更新分页UI
    updatePaginationUI(totalItems) {
        const container = document.getElementById('paginationContainer');

        // 小于等于每页显示数量隐藏分页
        if (totalItems <= this.pageSize) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';

        // 更新总数
        document.getElementById('totalItems').textContent = totalItems;

        // 更新每页显示数
        document.getElementById('pageSizeSelect').value = this.pageSize;

        // 更新页码显示
        this.updatePageNumbers();

        // 更新按钮状态
        this.updatePaginationButtons();
    }

    // 更新页码显示
    updatePageNumbers() {
        const container = document.getElementById('pageNumbers');
        container.innerHTML = '';

        // 配置参数
        const maxVisible = 11; // 显示11个页码
        const sideCount = 5;   // 左右各显示5个

        // 显示范围
        let start = Math.max(1, this.currentPage - sideCount);
        let end = Math.min(this.totalPages, this.currentPage + sideCount);

        if (end - start + 1 < maxVisible) {
            if (start === 1) {
                end = Math.min(this.totalPages, start + maxVisible - 1);
            } else if (end === this.totalPages) {
                start = Math.max(1, end - maxVisible + 1);
            }
        }

        if (this.totalPages <= maxVisible) {
            for (let i = 1; i <= this.totalPages; i++) {
                this.createPageButton(i, container);
            }
            return;
        }

        // 第一页
        if (start > 1) {
            this.createPageButton(1, container);
            if (start > 2) {
                const dots = document.createElement('span');
                dots.className = 'page-dots';
                dots.textContent = '...';
                container.appendChild(dots);
            }
        }

        // 中间页码
        for (let i = start; i <= end; i++) {
            this.createPageButton(i, container);
        }

        // 右侧省略号和最后一页
        if (end < this.totalPages) {
            if (end < this.totalPages - 1) {
                const dots = document.createElement('span');
                dots.className = 'page-dots';
                dots.textContent = '...';
                container.appendChild(dots);
            }
            this.createPageButton(this.totalPages, container);
        }
    }

    createPageDots(container, targetPage) {
        const dots = document.createElement('span');
        dots.className = 'page-dots clickable';
        dots.textContent = '...';
        dots.title = `快速跳转到第 ${targetPage} 页附近`;
        dots.onclick = () => {
            this.showQuickJump(targetPage);
        };
        container.appendChild(dots);
    }

    showQuickJump(suggestedPage) {
        const jumpInput = document.getElementById('pageJumpInput');
        if (jumpInput) {
            jumpInput.value = suggestedPage;
            jumpInput.focus();
            jumpInput.select();

            jumpInput.classList.add('highlight');
            setTimeout(() => {
                jumpInput.classList.remove('highlight');
            }, 2000);
        }
    }

    // 页码按钮
    createPageButton(pageNum, container) {
        const btn = document.createElement('button');
        btn.className = 'page-btn page-number';
        btn.textContent = pageNum;
        btn.onclick = () => this.goToPage(pageNum);

        if (pageNum === this.currentPage) {
            btn.classList.add('active');
        }

        container.appendChild(btn);
    }

    // 按钮状态
    updatePaginationButtons() {
        const firstBtn = document.querySelector('.page-first');
        const prevBtn = document.querySelector('.page-prev');
        const nextBtn = document.querySelector('.page-next');
        const lastBtn = document.querySelector('.page-last');

        firstBtn.disabled = this.currentPage === 1;
        prevBtn.disabled = this.currentPage === 1;
        nextBtn.disabled = this.currentPage === this.totalPages;
        lastBtn.disabled = this.currentPage === this.totalPages;

        const jumpInput = document.getElementById('pageJumpInput');
        jumpInput.max = this.totalPages;
        jumpInput.placeholder = `1-${this.totalPages}`;
    }

    // 分页操作
    changePageSize(size) {
        this.pageSize = parseInt(size);
        this.savePageSize(this.pageSize);
        this.currentPage = 1;
        this.render();

        // 滚动容器底部
        setTimeout(() => {
            const container = document.querySelector('.main-content');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }, 100);
    }

    goToPage(page) {
        if (page >= 1 && page <= this.totalPages) {
            // 切换页面忽略新求
            if (this.isChangingPage) return;

            this.isChangingPage = true;
            const prevPage = this.currentPage;
            this.currentPage = page;

            // 加载状态
            const paginationContainer = document.getElementById('paginationContainer');
            if (paginationContainer) {
                paginationContainer.classList.add('loading');
            }

            this.render();

            setTimeout(() => {
                const container = document.querySelector('.main-content');
                const tableContainer = document.querySelector('.table-container');
                if (container && tableContainer) {
                    if (page < prevPage) {
                        tableContainer.scrollTop = 0;
                    } else if (page > prevPage) {
                        const paginationRect = paginationContainer.getBoundingClientRect();
                        const containerRect = container.getBoundingClientRect();

                        if (paginationRect.bottom > containerRect.bottom) {
                            container.scrollTop = container.scrollHeight;
                        }
                    }
                }

                // 移除加载
                if (paginationContainer) {
                    paginationContainer.classList.remove('loading');
                }

                this.isChangingPage = false;
            }, 100);
        }
    }

    goToFirstPage() {
        this.goToPage(1);
    }

    goToLastPage() {
        this.goToPage(this.totalPages);
    }

    goToPrevPage() {
        this.goToPage(this.currentPage - 1);
    }

    goToNextPage() {
        this.goToPage(this.currentPage + 1);
    }

    jumpToPage() {
        const input = document.getElementById('pageJumpInput');
        const page = parseInt(input.value);
        if (page) {
            this.goToPage(page);
            input.value = '';
        }
    }

    createSessionRow(session, index) {
        const email = session.email || '未知';
        const isInvalid = this.invalidAccounts[email];
        const isPendingDelete = this.pendingDeletes.has(index);

        const row = document.createElement('tr');
        row.dataset.index = index;
        row.classList.add('session-row');
        if (isPendingDelete) {
            row.classList.add('pending-delete');
        }

        row.innerHTML = `
            <td class="checkbox-cell">
                <div class="checkbox-wrapper">
                    <input type="checkbox" 
                           class="checkbox-input session-checkbox" 
                           id="check-${index}"
                           data-index="${index}">
                    <label for="check-${index}" class="checkbox-label"></label>
                </div>
            </td>
            <td class="index-cell">${index + 1}</td>
            <td class="email-cell">
                <div class="email-info">
                    <span class="email-text clickable" 
                          data-email="${email}"
                          title="点击复制邮箱">
                        ${email}
                    </span>
                    ${email !== '未知' ? '<i class="icon-verified"></i>' : ''}
                </div>
            </td>
            <td class="cookie-cell">
                <div class="cookie-preview" 
                     data-cookie="${this.escapeHtml(session.cookie)}"
                     onclick="cookieManager.showCookiePreview(${index})">
                    ${this.formatCookiePreview(session.cookie)}
                </div>
            </td>
            <td class="status-cell">
                <span class="status-badge ${isInvalid ? 'status-invalid' : 'status-active'}" 
                      onclick="cookieManager.editInvalidStatus(${index}, '${email}')">
                    ${isInvalid || '有效'}
                </span>
            </td>
            <td class="actions-cell">
                ${isPendingDelete ? `
                    <button class="btn-icon btn-undo" onclick="cookieManager.undoDelete(${index})" title="撤销">
                        <i class="icon-undo"></i>
                    </button>
                ` : `
                    <button class="btn-icon btn-edit" onclick="cookieManager.editSession(${index})" title="编辑">
                        <i class="icon-edit"></i>
                    </button>
                    <button class="btn-icon btn-delete" onclick="cookieManager.markForDelete(${index})" title="删除">
                        <i class="icon-delete"></i>
                    </button>
                `}
            </td>
        `;

        // 绑定checkbox事件
        const checkbox = row.querySelector('.session-checkbox');
        checkbox.addEventListener('change', () => {
            this.toggleSelection(index, checkbox.checked);
        });

        const emailText = row.querySelector('.email-text');
        emailText.addEventListener('click', (e) => {
            e.stopPropagation(); // 阻止冒泡
            const email = e.target.dataset.email;
            this.extractSingleEmail(email);
        });

        // 行点击事件
        row.addEventListener('click', (e) => {
            if (e.target.closest('.btn-icon') ||
                e.target.closest('.checkbox-wrapper') ||
                e.target.closest('.status-badge') ||
                e.target.closest('.cookie-preview') ||
                e.target.closest('.email-text') ||
                e.target.closest('.icon-verified')) {
                return;
            }

            checkbox.checked = !checkbox.checked;
            this.toggleSelection(index, checkbox.checked);
        });

        return row;
    }

    // 提取单个邮箱
    async extractSingleEmail(email) {
        if (!email || email === '未知') {
            UI.showWarning('无效的邮箱地址');
            return;
        }

        try {
            await navigator.clipboard.writeText(email);

            const emailElements = document.querySelectorAll(`[data-email="${email}"]`);
            emailElements.forEach(el => {
                el.classList.add('copy-success');
                setTimeout(() => el.classList.remove('copy-success'), 500);
            });

            UI.showSuccess(`已复制邮箱: ${email}`);
        } catch (error) {
            const textarea = document.createElement('textarea');
            textarea.value = email;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            UI.showSuccess(`已复制邮箱: ${email}`);
        }
    }

    // 批量设置状态
    async batchSetStatus() {
        const selectedEmails = this.getSelectedEmails();

        if (selectedEmails.length === 0) {
            this.logOperation('BATCH_STATUS_NO_SELECTION');
            UI.showWarning('先选择要设置状态的Session');
            return;
        }

        this.logOperation('BATCH_STATUS_START', {
            count: selectedEmails.length,
            emails: selectedEmails
        });

        const emailsList = document.getElementById('selectedEmailsList');
        emailsList.innerHTML = selectedEmails.map(email => {
            const currentStatus = this.invalidAccounts[email] || '有效';
            return `
                <div class="email-item">
                    <span class="email-item-text">${email}</span>
                    <span class="email-item-status">当前: ${currentStatus}</span>
                </div>
            `;
        }).join('');

        // 清空输入框
        document.getElementById('batchStatusInput').value = '';

        this.batchStatusEmails = selectedEmails;

        this.showModal('batchStatusModal');
    }

    // 获取选中邮箱列表
    getSelectedEmails() {
        const emails = [];

        const dataSource = this.filteredSessions.length > 0 || this.isSearching
            ? this.filteredSessions
            : this.sessions;

        this.selectedIndices.forEach(index => {
            const session = this.sessions[index];
            if (session && session.email && session.email !== '未知') {
                emails.push(session.email);
            }
        });

        // 去重
        return [...new Set(emails)];
    }

    // 设置状态快捷方式
    setStatusShortcut(status) {
        document.getElementById('batchStatusInput').value = status;
        this.logOperation('STATUS_SHORTCUT_CLICKED', { status });
    }

    // 保存批量状态
    async saveBatchStatus() {
        const status = document.getElementById('batchStatusInput').value.trim();
        const emails = this.batchStatusEmails || [];

        if (emails.length === 0) {
            UI.showError('没有选中的邮箱');
            return;
        }

        this.logOperation('SAVE_BATCH_STATUS_START', {
            emailCount: emails.length,
            status: status || '清除状态'
        });

        try {
            UI.showLoading();

            const response = await API.batchUpdateStatus(emails, status);

            if (response.success) {
                this.logOperation('SAVE_BATCH_STATUS_SUCCESS', {
                    updated: response.updated,
                    status
                });

                this.closeModal('batchStatusModal');
                await this.refreshSessions();

                UI.showSuccess(`成功更新 ${response.updated} 个账号的状态`);
            } else {
                this.logOperation('SAVE_BATCH_STATUS_FAILED', {
                    error: response.error
                });
                UI.showError(response.error);
            }
        } catch (error) {
            this.logOperation('SAVE_BATCH_STATUS_ERROR', {
                error: error.message
            });
            UI.showError('批量更新状态失败');
        } finally {
            UI.hideLoading();
        }
    }

    // 复制到剪贴板方法
    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            UI.showSuccess('已复制到剪贴板');
        } catch (error) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            UI.showSuccess('已复制到剪贴板');
        }
    }

    // Cookie预览
    showCookiePreview(index) {
        const session = this.sessions[index];
        const email = session.email || '未知';

        // 解析cookie
        const fields = this.parseCookieFields(session.cookie);

        // 创建预览
        const previewWindow = document.createElement('div');
        previewWindow.className = 'cookie-preview-window';

        previewWindow.innerHTML = `
            <div class="cookie-preview-window-header">
                <div class="cookie-preview-window-title">
                    <i class="icon-cookie"></i> Cookie详情 - ${email}
                </div>
                <button class="cookie-preview-window-close" onclick="cookieManager.closeCookiePreview(this)">
                    <i class="icon-close"></i>
                </button>
            </div>
            <div class="cookie-preview-window-content">
                <div class="cookie-preview-box" style="border: none; background: transparent;">
                    ${this.createCookieFieldsPreview(fields, true)}
                </div>
            </div>
        `;

        document.body.appendChild(previewWindow);

        // 计算居中位置
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const modalWidth = previewWindow.offsetWidth;
        const modalHeight = previewWindow.offsetHeight;

        const left = (windowWidth - modalWidth) / 2;
        const top = (windowHeight - modalHeight) / 2;
        previewWindow.style.left = `${left}px`;
        previewWindow.style.top = `${top}px`;

        // 拖动
        this.makeDraggable(previewWindow);

        // 点击外部关闭
        setTimeout(() => {
            document.addEventListener('click', this.handleOutsideClick);
        }, 100);
    }

    // 关闭Cookie预览
    closeCookiePreview(button) {
        const previewWindow = button.closest('.cookie-preview-window');
        previewWindow.classList.add('closing');

        setTimeout(() => {
            previewWindow.remove();
            document.removeEventListener('click', this.handleOutsideClick);
        }, 300);
    }

    // 外部点击
    handleOutsideClick = (e) => {
        setTimeout(() => {
            const previewWindow = document.querySelector('.cookie-preview-window');
            if (previewWindow && !previewWindow.contains(e.target) && !e.target.closest('.cookie-preview')) {
                const closeBtn = previewWindow.querySelector('.cookie-preview-window-close');
                if (closeBtn) {
                    this.closeCookiePreview(closeBtn);
                }
            }
        }, 50);
    }

    // 元素可拖动
    makeDraggable(element) {
        const header = element.querySelector('.cookie-preview-window-header');
        let isDragging = false;
        let currentX = 0;
        let currentY = 0;
        let initialX = 0;
        let initialY = 0;

        const rect = element.getBoundingClientRect();
        element.style.left = rect.left + 'px';
        element.style.top = rect.top + 'px';
        element.style.transform = 'none'; // 清除transform

        header.addEventListener('mousedown', dragStart);

        function dragStart(e) {
            if (e.target.closest('.cookie-preview-window-close')) return;

            const rect = element.getBoundingClientRect();
            initialX = e.clientX - rect.left;
            initialY = e.clientY - rect.top;

            isDragging = true;
            element.style.cursor = 'move';
            element.style.userSelect = 'none';

            // 防止文本选择
            e.preventDefault();

            document.addEventListener('mousemove', drag);
            document.addEventListener('mouseup', dragEnd);
        }

        function drag(e) {
            if (!isDragging) return;

            e.preventDefault();

            // 计算新位置
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;

            // 边界检查
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;
            const elementWidth = element.offsetWidth;
            const elementHeight = element.offsetHeight;

            // 限制在窗口内
            currentX = Math.max(0, Math.min(currentX, windowWidth - elementWidth));
            currentY = Math.max(0, Math.min(currentY, windowHeight - elementHeight));

            element.style.left = currentX + 'px';
            element.style.top = currentY + 'px';
        }

        function dragEnd() {
            isDragging = false;
            element.style.cursor = '';
            element.style.userSelect = '';

            document.removeEventListener('mousemove', drag);
            document.removeEventListener('mouseup', dragEnd);
        }
    }

    // 更新刷新按钮状态
    updateRefreshButton() {
        const refreshBtn = document.querySelector('button[onclick="cookieManager.refreshSessions()"]');
        if (!refreshBtn) return;

        if (this.pendingDeletes.size > 0) {
            refreshBtn.innerHTML = `
                <i class="icon-check"></i>
                <span>确认删除 (${this.pendingDeletes.size})</span>
            `;
            refreshBtn.className = 'btn btn-danger';
        } else {
            refreshBtn.innerHTML = `
                <i class="icon-refresh"></i>
                <span>刷新</span>
            `;
            refreshBtn.className = 'btn btn-secondary';
        }
    }

    // 标记删除
    markForDelete(index) {
        this.logOperation('MARK_FOR_DELETE', {
            index,
            email: this.sessions[index]?.email || '未知',
            totalPending: this.pendingDeletes.size + 1
        });

        this.pendingDeletes.add(index);
        this.updateSessionRow(index);
        this.updateRefreshButton();
        UI.showInfo('已标记删除，点击确认删除按钮或撤销操作');
    }

    // 撤销删除
    undoDelete(index) {
        this.logOperation('UNDO_DELETE', {
            index,
            email: this.sessions[index]?.email || '未知',
            remainingPending: this.pendingDeletes.size - 1
        });

        this.pendingDeletes.delete(index);
        this.updateSessionRow(index);
        this.updateRefreshButton();
        UI.showSuccess('已撤销删除');
    }

    // 批量标记删除
    async deleteSelected() {
        const count = this.selectedIndices.size;

        this.logOperation('DELETE_SELECTED_START', {
            count,
            indices: Array.from(this.selectedIndices)
        });

        if (count === 0) {
            this.logOperation('DELETE_SELECTED_NONE');
            UI.showWarning('先选择要删除的Session');
            return;
        }

        this.selectedIndices.forEach(index => {
            this.pendingDeletes.add(index);
            this.updateSessionRow(index);
        });

        this.selectedIndices.clear();
        this.updateSelectAllState();
        this.updateRefreshButton();

        this.logOperation('DELETE_SELECTED_MARKED', {count});
        UI.showInfo(`已标记 ${count} 个Session删除，点击确认删除按钮或选择撤销`);
    }

    // 批量撤销
    undoSelected() {
        const pendingRows = document.querySelectorAll('.pending-delete .session-checkbox:checked');
        let count = 0;

        pendingRows.forEach(checkbox => {
            const index = parseInt(checkbox.dataset.index);
            if (this.pendingDeletes.has(index)) {
                this.pendingDeletes.delete(index);
                this.updateSessionRow(index);
                count++;
            }
        });

        if (count > 0) {
            UI.showSuccess(`已撤销 ${count} 个删除操作`);
        } else {
            UI.showWarning('选择要撤销的项目');
        }
    }

    // HTML转义
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatCookiePreview(cookie) {
        const maxLength = 160;  // 160 字符
        if (cookie.length <= maxLength) return cookie;
        return `${cookie.substring(0, maxLength)}...`;
    }

    toggleSelection(index, selected) {
        this.logOperation('TOGGLE_SELECTION', {
            index,
            selected,
            totalSelected: selected ? this.selectedIndices.size + 1 : this.selectedIndices.size - 1
        });

        if (selected) {
            this.selectedIndices.add(index);
        } else {
            this.selectedIndices.delete(index);
        }
        this.updateSelectAllState();
    }

    toggleSelectAll(selected) {
        const checkboxes = document.querySelectorAll('.session-checkbox');
        checkboxes.forEach((cb, index) => {
            cb.checked = selected;
            if (selected) {
                this.selectedIndices.add(index);
            } else {
                this.selectedIndices.delete(index);
            }
        });
    }

    updateSelectAllState() {
        const selectAll = document.getElementById('selectAll');
        const total = this.sessions.length;
        const selected = this.selectedIndices.size;

        selectAll.checked = selected === total && total > 0;
        selectAll.indeterminate = selected > 0 && selected < total;
    }

    updateStats() {
        const totalSessions = this.sessions.length;
        const invalidCount = this.sessions.filter(session => {
            const email = session.email || '未知';
            return this.invalidAccounts[email];
        }).length;

        document.getElementById('totalCount').textContent = String(totalSessions);
        document.getElementById('invalidCount').textContent = String(invalidCount);
    }

    // 局部更新
    updateSessionRow(index) {
        const row = document.querySelector(`tr[data-index="${index}"]`);
        if (!row) return;

        const session = this.sessions[index];
        const email = session.email || '未知';
        const isInvalid = this.invalidAccounts[email];
        const isPendingDelete = this.pendingDeletes.has(index);

        // 更新行和内容
        row.classList.toggle('pending-delete', isPendingDelete);

        // 更新状态单元格
        const statusCell = row.querySelector('.status-cell');
        if (statusCell) {
            statusCell.innerHTML = `
                <span class="status-badge ${isInvalid ? 'status-invalid' : 'status-active'}" 
                      onclick="cookieManager.editInvalidStatus(${index}, '${email}')">
                    ${isInvalid || '有效'}
                </span>
            `;
        }

        // 更新操作按钮
        const actionsCell = row.querySelector('.actions-cell');
        if (actionsCell) {
            actionsCell.innerHTML = isPendingDelete ? `
                <button class="btn-icon btn-undo" onclick="cookieManager.undoDelete(${index})" title="撤销">
                    <i class="icon-undo"></i>
                </button>
            ` : `
                <button class="btn-icon btn-edit" onclick="cookieManager.editSession(${index})" title="编辑">
                    <i class="icon-edit"></i>
                </button>
                <button class="btn-icon btn-delete" onclick="cookieManager.markForDelete(${index})" title="删除">
                    <i class="icon-delete"></i>
                </button>
            `;
        }
    }

    // 搜索
    filterSessions(searchText) {
        this.logOperation('SEARCH', {
            searchText,
            length: searchText.length,
            timestamp: new Date().toISOString()
        });

        this.isSearching = !!searchText.trim();

        if (!this.isSearching) {
            this.filteredSessions = [];
            this.currentPage = 1;
            this.render();
            return;
        }

        // 搜索获取结果
        const searchResults = this.smartSearch(searchText);

        // 根据得分排序
        this.filteredSessions = Array.from(searchResults.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([index]) => this.sessions[index]);

        // 重置到第一页
        this.currentPage = 1;
        this.render();

        this.logOperation('SEARCH_RESULTS', {
            searchText,
            resultCount: this.filteredSessions.length,
            totalCount: this.sessions.length
        });
    }

    // 搜索算法
    smartSearch(searchText) {
        const results = new Map(); // index -> score
        const searchLower = searchText.toLowerCase().trim();

        // 预处理
        const searchTerms = this.preprocessSearchTerms(searchLower);

        this.sessions.forEach((session, index) => {
            let score = 0;
            const email = (session.email || '未知').toLowerCase();
            const cookie = session.cookie.toLowerCase();

            // 邮箱精确匹配
            if (email !== '未知' && email === searchLower) {
                score += 1000;
            }

            // 模糊匹配
            if (email !== '未知') {
                if (email.includes(searchLower)) {
                    score += 500;
                }

                if (searchLower.startsWith('.') && email.includes(searchLower)) {
                    score += 400;
                }

                const emailUser = email.split('@')[0];
                if (emailUser.includes(searchLower)) {
                    score += 300;
                }

                const emailDomain = email.split('@')[1] || '';
                if (emailDomain.includes(searchLower)) {
                    score += 200;
                }

                score += this.calculateTermMatchScore(email, searchTerms, 100);
            }

            // Cookie匹配
            if (cookie.includes(searchLower)) {
                score += 50;
            }

            // Cookie字段匹配
            const cookieFields = this.parseCookieFields(session.cookie);
            Object.entries(cookieFields).forEach(([key, value]) => {
                if (key.toLowerCase().includes(searchLower) ||
                    value.toLowerCase().includes(searchLower)) {
                    score += 25;
                }
            });

            // 模糊匹配++拼写容错
            if (score === 0) {
                if (email !== '未知') {
                    const distance = this.levenshteinDistance(searchLower, email);
                    if (distance <= 3) {
                        score += Math.max(0, 100 - distance * 20);
                    }
                }
            }

            if (score > 0) {
                results.set(index, score);
            }
        });

        return results;
    }

    // 预处理
    preprocessSearchTerms(searchText) {
        const terms = searchText.split(/[\s\.\-_]+/).filter(term => term.length > 0);

        if (!terms.includes(searchText)) {
            terms.unshift(searchText);
        }

        return terms;
    }

    // 分词匹配
    calculateTermMatchScore(text, terms, baseScore) {
        let score = 0;
        let matchedTerms = 0;

        terms.forEach(term => {
            if (text.includes(term)) {
                matchedTerms++;
            }
        });

        if (matchedTerms > 0) {
            score = (matchedTerms / terms.length) * baseScore;
        }

        return Math.round(score);
    }

    // 距离算法
    levenshteinDistance(str1, str2) {
        const len1 = str1.length;
        const len2 = str2.length;
        const dp = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));

        for (let i = 0; i <= len1; i++) {
            dp[i][0] = i;
        }

        for (let j = 0; j <= len2; j++) {
            dp[0][j] = j;
        }

        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                if (str1[i - 1] === str2[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1];
                } else {
                    dp[i][j] = Math.min(
                        dp[i - 1][j] + 1,     // 删除
                        dp[i][j - 1] + 1,     // 插入
                        dp[i - 1][j - 1] + 1  // 替换
                    );
                }
            }
        }

        return dp[len1][len2];
    }

    // Cookie输入框改变时
    onCookieInput() {
        const cookieInput = document.getElementById('newCookie');
        const dsField = document.getElementById('dsField');
        const dsrField = document.getElementById('dsrField');

        // 格式化cookie（移除换行）
        const formattedCookie = cookieInput.value.replace(/[\r\n]+/g, ' ').trim();
        if (formattedCookie !== cookieInput.value.trim()) {
            this.logOperation('COOKIE_INPUT_FORMATTED', {
                hadNewlines: true
            });
            cookieInput.value = formattedCookie;
        }

        // 解析cookie字段
        const fields = this.parseCookieFields(formattedCookie);

        this.logOperation('COOKIE_INPUT_PARSED', {
            fieldsCount: Object.keys(fields).length,
            hasDS: !!fields.DS,
            hasDSR: !!fields.DSR
        });

        // 更新DS和DSR字段（包括清空）
        if (dsField) {
            dsField.value = fields.DS || '';
        }
        if (dsrField) {
            dsrField.value = fields.DSR || '';
        }

        // 更新预览
        this.updateCookiePreview(fields);
    }

// DS/DSR字段改变时
    onFieldInput() {
        const cookieInput = document.getElementById('newCookie');
        const dsField = document.getElementById('dsField');
        const dsrField = document.getElementById('dsrField');

        const cookieValue = cookieInput.value.trim();
        const dsValue = dsField.value.trim();
        const dsrValue = dsrField.value.trim();

        if (!dsValue && !dsrValue && !cookieValue) {
            cookieInput.value = '';
            this.updateCookiePreview({});
            return;
        }

        // 解析现有cookie
        const fields = this.parseCookieFields(cookieValue);

        // 更新DS和DSR字段
        if (dsValue) {
            fields.DS = dsValue;
        } else {
            delete fields.DS;
        }

        if (dsrValue) {
            fields.DSR = dsrValue;
        } else {
            delete fields.DSR;
        }

        // 重建cookie
        cookieInput.value = this.buildCookieString(fields);

        // 更新预览
        this.updateCookiePreview(fields);
    }

// 解析cookie字段
    parseCookieFields(cookieString) {
        const fields = {};
        if (!cookieString) return fields;

        const pairs = cookieString.split(/;\s*/);
        for (const pair of pairs) {
            const eqIndex = pair.indexOf('=');
            if (eqIndex > 0) {
                const key = pair.substring(0, eqIndex).trim();
                const value = pair.substring(eqIndex + 1).trim();
                if (key) {
                    fields[key] = value;
                }
            }
        }

        return fields;
    }

    // 构建cookie
    buildCookieString(fields) {
        const pairs = [];
        for (const [key, value] of Object.entries(fields)) {
            pairs.push(`${key}=${value}`);
        }
        return pairs.join('; ');
    }

    // Cookie字段预览HTML
    createCookieFieldsPreview(fields, clickToCopy = true) {
        if (Object.keys(fields).length === 0) {
            return '<div class="preview-placeholder">无Cookie数据</div>';
        }

        return Object.entries(fields).map(([key, value]) => {
            const isHighlight = key === 'DS' || key === 'DSR';
            const isLongValue = value.length > 100;
            const valueClass = isLongValue ? 'preview-value long-value' : 'preview-value';

            const copyAttr = clickToCopy ?
                `onclick="cookieManager.copyKeyValue('${this.escapeHtml(key).replace(/'/g, "\\'")}', '${this.escapeHtml(value).replace(/'/g, "\\'")}')" title="点击复制 ${key}=${value.substring(0, 20)}..."` : '';

            return `
                <div class="preview-field ${isHighlight ? 'highlight' : ''}">
                    <span class="preview-key">${this.escapeHtml(key)}</span>
                    <span class="${valueClass}" ${copyAttr}>
                        ${this.escapeHtml(value)}
                    </span>
                </div>
            `;
        }).join('');
    }

    // 复制键值对
    async copyKeyValue(key, value) {
        const text = `${key}=${value}`;
        try {
            await navigator.clipboard.writeText(text);
            UI.showSuccess(`已复制: ${key}=...`);
        } catch (error) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            UI.showSuccess(`已复制: ${key}=...`);
        }
    }

    // 更新Cookie预览
    updateCookiePreview(fields) {
        const previewDiv = document.getElementById('cookiePreview');
        if (!previewDiv) return;

        if (Object.keys(fields).length === 0) {
            previewDiv.innerHTML = '<div class="preview-placeholder">输入Cookie后将显示格式化预览</div>';
            return;
        }

        previewDiv.innerHTML = this.createCookieFieldsPreview(fields, true);
    }

    // 缓存管理
    saveModalCache(modalId, data) {
        const cacheKey = `cookieManager_${modalId}_cache`;
        localStorage.setItem(cacheKey, JSON.stringify(data));
    }

    getModalCache(modalId) {
        const cacheKey = `cookieManager_${modalId}_cache`;
        try {
            const cached = localStorage.getItem(cacheKey);
            return cached ? JSON.parse(cached) : null;
        } catch {
            return null;
        }
    }

    clearModalCache(modalId) {
        const cacheKey = `cookieManager_${modalId}_cache`;
        localStorage.removeItem(cacheKey);
    }

    // 模态框操作
    showModal(modalId) {
        this.logOperation('SHOW_MODAL', {modalId, timestamp: new Date().toISOString()});

        if (modalId === 'addModal') {
            const cache = this.getModalCache('addModal');
            if (cache) {
                this.logOperation('MODAL_CACHE_LOADED', {modalId, hasCachedData: true});
                document.getElementById('newCookie').value = cache.cookie || '';
                document.getElementById('dsField').value = cache.dsField || '';
                document.getElementById('dsrField').value = cache.dsrField || '';
                this.onCookieInput();
            } else {
                this.logOperation('MODAL_CACHE_EMPTY', {modalId});
                document.getElementById('newCookie').value = '';
                document.getElementById('dsField').value = '';
                document.getElementById('dsrField').value = '';
                document.getElementById('cookiePreview').innerHTML = '<div class="preview-placeholder">输入Cookie后将显示格式化预览</div>';
            }
        } else if (modalId === 'batchAddModal') {
            const cache = this.getModalCache('batchAddModal');
            if (cache) {
                this.logOperation('MODAL_CACHE_LOADED', {
                    modalId,
                    cookiesCount: cache.cookies?.split('\n').length || 0
                });
                document.getElementById('batchCookies').value = cache.cookies || '';
                this.onBatchInput();
            } else {
                this.logOperation('MODAL_CACHE_EMPTY', {modalId});
                document.getElementById('batchCookies').value = '';
            }
        }

        document.getElementById(modalId).classList.add('show');
        document.body.classList.add('modal-open');
    }

    closeModal(modalId) {
        this.logOperation('CLOSE_MODAL', {modalId});

        const modal = document.getElementById(modalId);
        if (modal) {
            if (modalId === 'addModal') {
                const data = {
                    cookie: document.getElementById('newCookie').value,
                    dsField: document.getElementById('dsField').value,
                    dsrField: document.getElementById('dsrField').value
                };
                this.saveModalCache('addModal', data);
                this.logOperation('MODAL_CACHE_SAVED', {modalId, hasData: !!data.cookie});
            } else if (modalId === 'batchAddModal') {
                const data = {
                    cookies: document.getElementById('batchCookies').value
                };
                this.saveModalCache('batchAddModal', data);
                this.logOperation('MODAL_CACHE_SAVED', {modalId, cookiesCount: data.cookies?.split('\n').length || 0});
            }

            if (modalId === 'statusModal') {
                modal.remove();
            } else {
                modal.classList.remove('show');
            }
        }
        document.body.classList.remove('modal-open');
    }

    // Session操作
    async addSession() {
        this.logOperation('ADD_SESSION_START');

        const cookieInput = document.getElementById('newCookie');
        const dsField = document.getElementById('dsField');
        const dsrField = document.getElementById('dsrField');

        let cookie = cookieInput.value.trim();

        // 如果只输入DS/DSR，构建cookie
        if (!cookie && (dsField.value || dsrField.value)) {
            this.logOperation('BUILD_COOKIE_FROM_FIELDS', {hasDS: !!dsField.value, hasDSR: !!dsrField.value});
            const fields = {};
            if (dsField.value.trim()) {
                fields.DS = dsField.value.trim();
            }
            if (dsrField.value.trim()) {
                fields.DSR = dsrField.value.trim();
            }
            cookie = this.buildCookieString(fields);
        }

        if (!cookie) {
            this.logOperation('ADD_SESSION_EMPTY_COOKIE');
            UI.showWarning('输入Cookie或DS/DSR字段');
            return;
        }

        try {
            UI.showLoading();

            // 验证
            this.logOperation('VALIDATE_COOKIE_START', {cookieLength: cookie.length});
            const validateResponse = await API.validateCookie(cookie);
            if (!validateResponse.data.isValid) {
                this.logOperation('ADD_SESSION_INVALID_COOKIE');
                UI.showError('无效的Cookie格式');
                return;
            }

            if (!validateResponse.data.hasDsr) {
                this.logOperation('ADD_SESSION_NO_DSR');
                const confirmed = await UI.confirm('该Cookie缺少DSR字段，可能无法正常使用。是否继续？');
                if (!confirmed) {
                    this.logOperation('ADD_SESSION_CANCELLED_NO_DSR');
                    return;
                }
            }

            // 添加
            const response = await API.addSession(cookie);
            if (response.success) {
                this.logOperation('ADD_SESSION_SUCCESS', {email: validateResponse.data.email});

                cookieInput.value = '';
                dsField.value = '';
                dsrField.value = '';
                document.getElementById('cookiePreview').innerHTML = '<div class="preview-placeholder">输入Cookie后将显示格式化预览</div>';

                this.clearModalCache('addModal');

                this.closeModal('addModal');
                await this.refreshSessions();
                UI.showSuccess('添加成功');
            } else {
                this.logOperation('ADD_SESSION_FAILED', {error: response.error});
            }
        } catch (error) {
            this.logOperation('ADD_SESSION_ERROR', {error: error.message});
            UI.showError(error.message);
        } finally {
            UI.hideLoading();
        }
    }

    // 编辑无效状态
    async editInvalidStatus(index, email) {
        this.logOperation('EDIT_INVALID_STATUS_START', {index, email});
        if (!email || email === '未知') {
            UI.showWarning('无法编辑未知邮箱状态');
            return;
        }

        this.editingStatusEmail = email;
        const currentStatus = this.invalidAccounts[email] || '';

        const modal = document.createElement('div');
        modal.id = 'statusModal';
        modal.className = 'modal show';
        modal.innerHTML = `
            <div class="modal-wrapper">
                <div class="modal-content">
                    <div class="modal-header">
                        <h2 class="modal-title">
                            <i class="icon-edit"></i>
                            编辑账号状态
                        </h2>
                        <button class="modal-close" onclick="cookieManager.closeModal('statusModal')">
                            <i class="icon-close"></i>
                        </button>
                    </div>
                    <div class="modal-body">
                        <div class="form-group">
                            <label class="form-label">邮箱</label>
                            <input type="text" class="form-input" value="${email}" readonly>
                        </div>
                        <div class="form-group">
                            <label class="form-label">状态说明</label>
                            <input type="text" 
                                   id="statusInput" 
                                   class="form-input" 
                                   value="${currentStatus}" 
                                   placeholder="留空表示有效">
                            <div class="form-hint">常用状态：已失效、无有效订阅、账号或域名因滥用被封禁等</div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-primary" onclick="cookieManager.saveInvalidStatus()">
                            <i class="icon-save"></i>
                            保存
                        </button>
                        <button class="btn btn-secondary" onclick="cookieManager.closeModal('statusModal')">
                            <i class="icon-close"></i>
                            取消
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        document.body.classList.add('modal-open');

        this.logOperation('EDIT_INVALID_STATUS_MODAL_SHOWN', {
            email,
            currentStatus
        });
    }

    // 保存无效状态
    async saveInvalidStatus() {
        const status = document.getElementById('statusInput').value.trim();

        this.logOperation('SAVE_INVALID_STATUS_START', {
            email: this.editingStatusEmail,
            status,
            isRemoving: !status
        });

        try {
            UI.showLoading();
            const response = await API.updateInvalidStatus(this.editingStatusEmail, status);

            if (response.success) {
                this.logOperation('SAVE_INVALID_STATUS_SUCCESS', {
                    email: this.editingStatusEmail,
                    status
                });

                this.closeModal('statusModal');
                await this.refreshSessions();
                UI.showSuccess('状态更新成功');
            } else {
                this.logOperation('SAVE_INVALID_STATUS_FAILED', {
                    email: this.editingStatusEmail,
                    error: response.error
                });
            }
        } catch (error) {
            this.logOperation('SAVE_INVALID_STATUS_ERROR', {
                email: this.editingStatusEmail,
                error: error.message
            });
            UI.showError(error.message);
        } finally {
            UI.hideLoading();
        }
    }

    async batchAddSessions() {
        this.logOperation('BATCH_ADD_START');

        const textarea = document.getElementById('batchCookies');
        const text = textarea.value.trim();

        if (!text) {
            this.logOperation('BATCH_ADD_EMPTY');
            UI.showWarning('输入Cookie');
            return;
        }

        const cookies = text.split('\n').map(line => line.trim()).filter(line => line);

        this.logOperation('BATCH_ADD_PARSED', {count: cookies.length});

        if (cookies.length === 0) {
            this.logOperation('BATCH_ADD_NO_VALID');
            UI.showWarning('没有有效的Cookie');
            return;
        }

        try {
            UI.showLoading();
            const response = await API.batchAddSessions(cookies);

            if (response.success) {
                this.logOperation('BATCH_ADD_SUCCESS', {
                    added: response.results?.added?.length || 0,
                    skipped: response.results?.skipped?.length || 0,
                    invalid: response.results?.invalid?.length || 0
                });

                textarea.value = '';
                this.clearModalCache('batchAddModal');

                this.closeModal('batchAddModal');
                await this.refreshSessions();

                // 显示详细结果
                const {results} = response;
                let message = response.message;

                if (results.invalid.length > 0) {
                    message += '\n\n无效的Cookie:';
                    results.invalid.forEach(item => {
                        message += `\n- ${item.cookie.substring(0, 30)}...`;
                    });
                }

                UI.showInfo(message);
            } else {
                this.logOperation('BATCH_ADD_FAILED', {error: response.error});
            }
        } catch (error) {
            this.logOperation('BATCH_ADD_ERROR', {error: error.message});
            UI.showError(error.message);
        } finally {
            UI.hideLoading();
        }
    }

    // 批量输入更新统计
    onBatchInput() {
        const textarea = document.getElementById('batchCookies');
        const countSpan = document.getElementById('batchCount');

        const lines = textarea.value.split('\n').filter(line => line.trim());
        countSpan.textContent = lines.length;

        this.logOperation('BATCH_INPUT_CHANGED', {
            linesCount: lines.length,
            timestamp: new Date().toISOString()
        });
    }

    async editSession(index) {
        this.logOperation('EDIT_SESSION_START', {
            index,
            email: this.sessions[index]?.email || '未知'
        });

        this.editingIndex = index;
        const session = this.sessions[index];
        document.getElementById('editCookie').value = session.cookie;
        this.showModal('editModal');
    }

    async updateSession() {
        this.logOperation('UPDATE_SESSION_START', {index: this.editingIndex});

        const cookie = document.getElementById('editCookie').value.trim();

        if (!cookie) {
            this.logOperation('UPDATE_SESSION_EMPTY_COOKIE');
            UI.showWarning('输入Cookie');
            return;
        }

        try {
            UI.showLoading();
            const response = await API.updateSession(this.editingIndex, cookie);

            if (response.success) {
                this.logOperation('UPDATE_SESSION_SUCCESS', {
                    index: this.editingIndex,
                    email: response.email
                });

                this.closeModal('editModal');
                await this.refreshSessions();
                UI.showSuccess('更新成功');
            } else {
                this.logOperation('UPDATE_SESSION_FAILED', {
                    index: this.editingIndex,
                    error: response.error
                });
            }
        } catch (error) {
            this.logOperation('UPDATE_SESSION_ERROR', {
                index: this.editingIndex,
                error: error.message
            });
            UI.showError(error.message);
        } finally {
            UI.hideLoading();
        }
    }

    async extractEmails() {
        const indices = this.selectedIndices.size > 0
            ? Array.from(this.selectedIndices)
            : this.sessions.map((_, index) => index);

        this.logOperation('EXTRACT_EMAILS_START', {
            mode: this.selectedIndices.size > 0 ? 'selected' : 'all',
            count: indices.length
        });

        const emails = indices
            .map(i => this.sessions[i]?.email)
            .filter(email => email && email !== '未知');

        if (emails.length === 0) {
            this.logOperation('EXTRACT_EMAILS_NONE');
            UI.showWarning('没有可提取的邮箱');
            return;
        }

        const emailText = emails.join('\n');

        try {
            await navigator.clipboard.writeText(emailText);
            this.logOperation('EXTRACT_EMAILS_SUCCESS', {
                count: emails.length,
                method: 'clipboard'
            });
            UI.showSuccess(`已复制 ${emails.length} 个邮箱到剪贴板`);
        } catch (error) {
            this.logOperation('EXTRACT_EMAILS_FALLBACK', {
                count: emails.length,
                error: error.message
            });
            // 显示邮箱列表供手动复制
            UI.showEmailList(emails);
        }
    }

    // 保存调试面板位置
    saveDebugPanelPosition(x, y) {
        // 获取面板尺寸
        const panel = document.querySelector('.debug-panel');
        if (!panel) return;

        const panelWidth = panel.offsetWidth;
        const panelHeight = panel.offsetHeight;
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const minVisibleArea = 50;

        // 限制x坐标：左边不能完全出界，右边至少留50px
        const safeX = Math.max(-panelWidth + minVisibleArea, Math.min(x, windowWidth - minVisibleArea));

        // 限制y坐标：上边不能完全出界，下边至少留50px
        const safeY = Math.max(-panelHeight + minVisibleArea, Math.min(y, windowHeight - minVisibleArea));

        localStorage.setItem('debugPanelPosition', JSON.stringify({x: safeX, y: safeY}));
    }

    // 获取保存位置
    getDebugPanelPosition() {
        try {
            const saved = localStorage.getItem('debugPanelPosition');
            return saved ? JSON.parse(saved) : null;
        } catch {
            return null;
        }
    }

    // 后端日志同步
    async syncBackendLogs() {
        if (!this.debugMode) return;

        try {
            const response = await fetch('/cookie-manager/api/debug/logs');
            const data = await response.json();

            if (data.success && data.logs) {
                // 后端日志转换前端
                data.logs.forEach(log => {
                    // 判断日志类型
                    let logType = log.type || 'log';

                    // info 类型统一为 log
                    if (logType === 'info') {
                        logType = 'log';
                    }

                    // 根据内容判断类型
                    if (log.message && log.message.toLowerCase().includes('error')) {
                        logType = 'error';
                    } else if (log.message && log.message.toLowerCase().includes('warn')) {
                        logType = 'warn';
                    }

                    // 格式化消息
                    let formattedMessage = `[${log.category}] ${log.message}`;

                    if (log.data) {
                        if (typeof log.data === 'object') {
                            const dataStr = JSON.stringify(log.data, null, 2);
                            formattedMessage += '\n' + `<pre class="json-content">${this.escapeHtml(dataStr)}</pre>`;
                        } else {
                            formattedMessage += ` - ${log.data}`;
                        }
                    }

                    const formattedLog = {
                        type: logType,
                        timestamp: log.timestamp,
                        message: formattedMessage.trim()
                    };

                    // 添加到前端显示
                    this.appendDebugLog(formattedLog);
                });
                // 清空后端日志缓存
                await fetch('/cookie-manager/api/debug/clear', {method: 'POST'});
            }
        } catch (error) {
            console.error('Failed to sync backend logs:', error);
        }
    }

    // 调试面板
    showDebugPanel() {
        // 移除存在面板
        const existingPanel = document.querySelector('.debug-panel');
        if (existingPanel) existingPanel.remove();

        const panel = document.createElement('div');
        panel.className = 'debug-panel';
        panel.innerHTML = `
            <div class="debug-header debug-draggable">
                <span>🐛 调试模式</span>
                <div class="debug-controls">
                    <button class="debug-filter active" data-filter="all" onclick="cookieManager.onFilterChange(this)">全部</button>
                    <button class="debug-filter" data-filter="log" onclick="cookieManager.onFilterChange(this)">日志</button>
                    <button class="debug-filter" data-filter="info" onclick="cookieManager.onFilterChange(this)">信息</button>
                    <button class="debug-filter" data-filter="error" onclick="cookieManager.onFilterChange(this)">错误</button>
                    <button class="debug-filter" data-filter="warn" onclick="cookieManager.onFilterChange(this)">警告</button>
                    <button class="debug-clear" onclick="cookieManager.clearDebugLogs()">
                        <i class="icon-clear"></i>清空
                    </button>
                    <button class="debug-close" onclick="cookieManager.toggleDebugMode()">
                        <i class="icon-close"></i>关闭
                    </button>
                </div>
            </div>
            
            <div class="debug-options">
                <div class="debug-toggle-group">
                    <label class="toggle-switch">
                        <input type="checkbox" id="debugInfoToggle" onchange="cookieManager.toggleInfoLogging(this)">
                        <span class="toggle-slider"></span>
                        <span class="toggle-label">记录 INFO</span>
                    </label>
                    <label class="toggle-switch">
                        <input type="checkbox" id="debugNetworkToggle" onchange="cookieManager.toggleNetworkLogging(this)">
                        <span class="toggle-slider"></span>
                        <span class="toggle-label">记录 Network</span>
                    </label>
                </div>
                <div class="debug-refresh-mode">
                    <button class="refresh-mode-btn" onclick="cookieManager.toggleRefreshMode()" title="点击切换刷新模式">
                        <i class="refresh-icon">⏸️</i>
                        <span class="refresh-mode-text">不刷新记录</span>
                    </button>
                </div>
            </div>
            
            <div class="debug-stats">
                <p><strong>Sessions:</strong> <span>${this.sessions.length}</span></p>
                <p><strong>Invalid:</strong> <span>${Object.keys(this.invalidAccounts).length}</span></p>
                <p><strong>Selected:</strong> <span>${this.selectedIndices.size}</span></p>
                <p><strong>Pending:</strong> <span>${this.pendingDeletes.size}</span></p>
            </div>
            <div class="debug-logs-container">
                <div class="debug-logs" id="debugLogs"></div>
            </div>
            <div class="debug-actions">
                <button onclick="cookieManager.exportDebugLog()">
                    <i class="icon-download"></i>导出日志
                </button>
            </div>
            <div class="debug-resize-handle"></div>
        `;
        document.body.appendChild(panel);

        this.refreshMode = this.getRefreshMode() || 'auto-scroll'; // 默认自动刷新+滚动
        this.updateRefreshModeDisplay();

        // 恢复INFO记录状态
        const savedInfoLogging = this.getInfoLoggingState();
        const infoToggle = document.getElementById('debugInfoToggle');
        if (infoToggle) {
            infoToggle.checked = savedInfoLogging;
            this.infoLoggingEnabled = savedInfoLogging;
        }

        // 恢复Network记录状态
        const savedNetworkLogging = this.getNetworkLoggingState();
        const networkToggle = document.getElementById('debugNetworkToggle');
        if (networkToggle) {
            networkToggle.checked = savedNetworkLogging;
            this.networkLoggingEnabled = savedNetworkLogging;
        }

        // 通知debug-logger
        if (window.debugLogger) {
            window.debugLogger.setInfoLogging(this.infoLoggingEnabled);
            window.debugLogger.setNetworkLogging(this.networkLoggingEnabled);
        }

        // 恢复保存高度
        const savedHeight = this.getDebugPanelHeight();
        if (savedHeight) {
            panel.style.height = `${savedHeight}px`;
        }

        // 恢复保存位置
        const savedPosition = this.getDebugPanelPosition();
        if (savedPosition) {
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;
            const panelWidth = panel.offsetWidth;
            const panelHeight = panel.offsetHeight;

            const minVisibleArea = 50;

            let x = savedPosition.x;
            let y = savedPosition.y;

            // 检查是否会完全不可见
            if (x + minVisibleArea < 0 || x > windowWidth - minVisibleArea ||
                y + minVisibleArea < 0 || y > windowHeight - minVisibleArea) {
                // 重置到右下角默认位置
                x = windowWidth - panelWidth - 20;
                y = windowHeight - panelHeight - 20;
            } else {
                // 确保至少有部分可见
                x = Math.max(-panelWidth + minVisibleArea, Math.min(x, windowWidth - minVisibleArea));
                y = Math.max(-panelHeight + minVisibleArea, Math.min(y, windowHeight - minVisibleArea));
            }

            panel.style.left = `${x}px`;
            panel.style.top = `${y}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }

        this.makeDebugPanelDraggable(panel);
        this.makeDebugPanelResizable(panel);

        // 显示日志
        this.displayDebugLogs();

        // 订阅新日志
        if (window.debugLogger) {
            // 移除旧监听器
            if (this.debugLogListener) {
                window.debugLogger.unsubscribe(this.debugLogListener);
            }

            this.debugLogListener = (log) => {
                this.appendDebugLog(log);
            };
            window.debugLogger.subscribe(this.debugLogListener);
        }

        // 同步后端日志
        this.syncBackendLogs();

        // 定时同步后端日志
        if (this.backendLogTimer) {
            clearInterval(this.backendLogTimer);
        }
        if (this.refreshMode !== 'none') {
            this.syncBackendLogs();
            this.backendLogTimer = setInterval(() => {
                this.syncBackendLogs();
            }, 2000);
        }
    }

    // 刷新模式
    toggleRefreshMode() {
        const modes = ['none', 'auto', 'auto-scroll'];
        const currentIndex = modes.indexOf(this.refreshMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        this.refreshMode = modes[nextIndex];

        localStorage.setItem('debugRefreshMode', this.refreshMode);
        this.updateRefreshModeDisplay();

        if (this.refreshMode === 'none') {
            if (this.backendLogTimer) {
                clearInterval(this.backendLogTimer);
                this.backendLogTimer = null;
            }
        } else if (!this.backendLogTimer) {
            this.syncBackendLogs();
            this.backendLogTimer = setInterval(() => {
                this.syncBackendLogs();
            }, 2000);
        }
    }

    updateRefreshModeDisplay() {
        const btn = document.querySelector('.refresh-mode-btn');
        if (!btn) return;

        const icon = btn.querySelector('.refresh-icon');
        const text = btn.querySelector('.refresh-mode-text');

        switch (this.refreshMode) {
            case 'none':
                icon.textContent = '⏸️';
                text.textContent = '不刷新记录';
                btn.className = 'refresh-mode-btn mode-none';
                break;
            case 'auto':
                icon.textContent = '🔄';
                text.textContent = '自动刷新';
                btn.className = 'refresh-mode-btn mode-auto';
                break;
            case 'auto-scroll':
                icon.textContent = '📜';
                text.textContent = '自动刷新+滚动';
                btn.className = 'refresh-mode-btn mode-auto-scroll';
                break;
        }
    }

    getRefreshMode() {
        return localStorage.getItem('debugRefreshMode');
    }

    // Network日志开关控制
    toggleNetworkLogging(checkbox) {
        this.networkLoggingEnabled = checkbox.checked;
        localStorage.setItem('debugNetworkLogging', checkbox.checked);

        if (window.debugLogger) {
            window.debugLogger.setNetworkLogging(checkbox.checked);
        }

        if (!checkbox.checked) {
            UI.showInfo('Network日志记录已关闭');
        } else {
            UI.showInfo('Network日志记录已开启');
        }
    }

    // 获取Network记录状态
    getNetworkLoggingState() {
        const saved = localStorage.getItem('debugNetworkLogging');
        return saved === 'true'; // 默认为false
    }

    // INFO日志开关控制
    toggleInfoLogging(checkbox) {
        this.infoLoggingEnabled = checkbox.checked;
        localStorage.setItem('debugInfoLogging', checkbox.checked);

        if (window.debugLogger) {
            window.debugLogger.setInfoLogging(checkbox.checked);
        }

        // 如果关闭INFO立即过滤现有INFO日志
        if (!checkbox.checked) {
            const activeFilter = document.querySelector('.debug-filter.active')?.dataset.filter || 'all';
            if (activeFilter === 'info') {
                document.querySelector('.debug-filter[data-filter="all"]').click();
            } else {
                this.displayDebugLogs(activeFilter);
            }
        }
    }

    // 获取INFO记录状态
    getInfoLoggingState() {
        const saved = localStorage.getItem('debugInfoLogging');
        return saved === 'true'; // 默认为false
    }

    // 调整大小
    makeDebugPanelResizable(panel) {
        const resizeHandle = panel.querySelector('.debug-resize-handle');
        let isResizing = false;
        let startY = 0;
        let startHeight = 0;

        // 动态设置最大高度
        const maxAllowedHeight = Math.min(window.innerHeight * 0.8, 1400);
        panel.style.maxHeight = `${maxAllowedHeight}px`;

        resizeHandle.addEventListener('mousedown', startResize);

        function startResize(e) {
            isResizing = true;
            startY = e.clientY;
            startHeight = panel.offsetHeight;

            document.addEventListener('mousemove', resize);
            document.addEventListener('mouseup', stopResize);

            // 防止选择文本
            e.preventDefault();
            document.body.style.userSelect = 'none';
            panel.classList.add('resizing');
        }

        function resize(e) {
            if (!isResizing) return;

            // 向下拖动增加高度
            const deltaY = e.clientY - startY;
            const newHeight = startHeight + deltaY;

            // 限制高度范围
            const minHeight = 200;
            const maxHeight = Math.min(window.innerHeight * 0.8, 1400);
            const finalHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));

            panel.style.height = `${finalHeight}px`;
        }

        function stopResize() {
            isResizing = false;
            document.removeEventListener('mousemove', resize);
            document.removeEventListener('mouseup', stopResize);
            document.body.style.userSelect = '';
            panel.classList.remove('resizing');

            // 保存高度
            cookieManager.saveDebugPanelHeight(panel.offsetHeight);
        }
    }

    // 保存和获取面板高度
    saveDebugPanelHeight(height) {
        localStorage.setItem('debugPanelHeight', height);
    }

    getDebugPanelHeight() {
        const saved = localStorage.getItem('debugPanelHeight');
        return saved ? parseInt(saved) : null;
    }

    makeDebugPanelDraggable(panel) {
        const header = panel.querySelector('.debug-draggable');
        let isDragging = false;
        let initialMouseX = 0;
        let initialMouseY = 0;
        let initialPanelX = 0;
        let initialPanelY = 0;

        header.addEventListener('mousedown', dragStart);

        function dragStart(e) {
            if (e.target.closest('button')) return;

            isDragging = true;

            // 记录初始鼠标位置
            initialMouseX = e.clientX;
            initialMouseY = e.clientY;

            // 记录面板初始位置
            const rect = panel.getBoundingClientRect();
            initialPanelX = rect.left;
            initialPanelY = rect.top;

            // 设置拖动样式
            panel.classList.add('dragging');
            header.style.cursor = 'grabbing';

            document.addEventListener('mousemove', drag);
            document.addEventListener('mouseup', dragEnd);
        }

        function drag(e) {
            if (!isDragging) return;

            e.preventDefault();

            // 计算鼠标移动距离
            const deltaX = e.clientX - initialMouseX;
            const deltaY = e.clientY - initialMouseY;

            // 允许拖任何位置
            const newX = initialPanelX + deltaX;
            const newY = initialPanelY + deltaY;

            panel.style.left = newX + 'px';
            panel.style.top = newY + 'px';
        }

        function dragEnd() {
            isDragging = false;
            panel.classList.remove('dragging');
            header.style.cursor = '';

            // 保存位置
            const rect = panel.getBoundingClientRect();
            cookieManager.saveDebugPanelPosition(rect.left, rect.top);

            document.removeEventListener('mousemove', drag);
            document.removeEventListener('mouseup', dragEnd);
        }
    }

    // 过滤器切换
    onFilterChange(button) {
        const panel = document.querySelector('.debug-panel');
        const filter = button.dataset.filter;

        // 更新按钮状态
        panel.querySelectorAll('.debug-filter').forEach(b => b.classList.remove('active'));
        button.classList.add('active');

        // 如果不是"全部"，启用紧凑模式
        if (filter !== 'all') {
            panel.classList.add('compact-mode');
        } else {
            panel.classList.remove('compact-mode');
        }

        // 过滤日志
        this.filterDebugLogs(filter);

        // 测试
        // if (this.debugMode && window.debugLogger) {
        //     setTimeout(() => {
        //         if (filter === 'error') {
        //             console.error('测试错误消息 - ' + new Date().toLocaleTimeString());
        //         } else if (filter === 'warn') {
        //             console.warn('测试警告消息 - ' + new Date().toLocaleTimeString());
        //         } else if (filter === 'log') {
        //             console.log('测试日志消息 - ' + new Date().toLocaleTimeString());
        //         }
        //     }, 100);
        // }
    }

    // 显示调试日志
    displayDebugLogs(filter = 'all') {
        const logsContainer = document.getElementById('debugLogs');
        if (!logsContainer) return;

        if (logsContainer.children.length === 0 && window.debugLogger) {
            const logs = window.debugLogger.getLogs();
            logs.forEach(log => {
                this.appendDebugLog(log, false); // 不自动滚动
            });
        }

        // 根据过滤器显示/隐藏日志
        const logItems = logsContainer.querySelectorAll('.debug-log-item');
        logItems.forEach(item => {
            item.style.removeProperty('display');

            if (filter === 'all') {
                item.classList.remove('hidden-by-filter');
            } else {
                // 获取日志类型
                const hasMatchingType = item.classList.contains(`debug-log-${filter}`);
                if (hasMatchingType) {
                    item.classList.remove('hidden-by-filter');
                } else {
                    item.classList.add('hidden-by-filter');
                }
            }
        });

        // 滚动到底部
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    // 追加单条日志
    appendDebugLog(log, autoScroll = true) {
        const logsContainer = document.getElementById('debugLogs');
        if (!logsContainer) return;

        const activeFilter = document.querySelector('.debug-filter.active')?.dataset.filter || 'all';

        const logElement = document.createElement('div');
        logElement.className = `debug-log-item debug-log-${log.type}`;

        // 美化日志
        const formattedMessage = this.formatLogMessage(log);

        // 检查消息长度
        const isLongMessage = formattedMessage.length > 150 || formattedMessage.includes('<pre');

        if (isLongMessage) {
            logElement.innerHTML = `<div class="log-wrapper">
    <div class="log-header">
    <span class="debug-log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
    <span class="debug-log-type">[${log.type.toUpperCase()}]</span>
    </div>
    <div class="log-content-wrapper">
    <div class="debug-log-message collapsible">${formattedMessage}</div>
    </div>
    <div class="log-expand-bar" onclick="cookieManager.toggleLogDetail(this)" title="点击展开/收起">
    <i class="expand-icon">▼</i>
    </div>
    </div>`;
            logElement.classList.add('expandable');
        } else {
            logElement.innerHTML = `<div class="log-wrapper">
    <div class="log-header">
    <span class="debug-log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
    <span class="debug-log-type">[${log.type.toUpperCase()}]</span>
    </div>
    <div class="log-content-wrapper">
    <div class="debug-log-message">${formattedMessage}</div>
    </div>
    </div>`;
        }

        // 根据当前过滤器决定是否显示
        if (activeFilter !== 'all' && activeFilter !== log.type) {
            logElement.style.display = 'none';
        }

        if (activeFilter !== 'all' && activeFilter !== log.type) {
            logElement.classList.add('hidden-by-filter');
        }

        logsContainer.appendChild(logElement);

        // 限制显示数量
        while (logsContainer.children.length > 200) {
            logsContainer.removeChild(logsContainer.firstChild);
        }

        // 滚动到底部
        if (autoScroll && this.refreshMode === 'auto-scroll' && logElement.style.display !== 'none') {
            logsContainer.scrollTop = logsContainer.scrollHeight;
        }
    }

    // 展开/收起
    toggleLogDetail(expandBar) {
        const logItem = expandBar.closest('.debug-log-item');
        const messageDiv = logItem.querySelector('.debug-log-message');
        const icon = expandBar.querySelector('.expand-icon');

        if (logItem.classList.contains('expanded')) {
            // 收起
            logItem.classList.remove('expanded');
            messageDiv.classList.add('collapsible');
            icon.textContent = '▼';
        } else {
            // 展开
            logItem.classList.add('expanded');
            messageDiv.classList.remove('collapsible');
            icon.textContent = '▲';
        }
    }

    // 格式化日志
    formatLogMessage(log) {
        let message = log.message;
        message = this.escapeHtml(message);

        if (message.includes('[') && message.includes(']')) {
            // 提取分类标签+高亮
            message = message.replace(/\[([^\]]+)\]/g, '<span class="log-category">[$1]</span>');
        }

        // 处理JSON
        if (message.includes('{') || message.includes('[')) {
            message = this.beautifyJSON(message);
        }

        // 高亮关键词
        message = this.highlightKeywords(message);

        return message.trim();
    }

    // 美化JSON
    beautifyJSON(message) {
        // 查找JSON
        const jsonMatch = message.match(/(\{[\s\S]*}|\[[\s\S]*])/);
        if (jsonMatch) {
            try {
                const jsonStr = jsonMatch[1];
                const decodedJson = jsonStr.replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&');

                const jsonObj = JSON.parse(decodedJson);
                const beautified = JSON.stringify(jsonObj, null, 2);

                message = message.replace(this.escapeHtml(jsonStr),
                    `<pre class="json-content">${this.escapeHtml(beautified)}</pre>`
                );
            } catch (e) {
                // 不是有效JSON，保持原样
            }
        }
        return message;
    }

    // 高亮关键词
    highlightKeywords(message) {
        const keywords = {
            'email': 'keyword-email',
            'cookie': 'keyword-cookie',
            'success': 'keyword-success',
            'failed': 'keyword-failed',
            'error': 'keyword-error',
            'warning': 'keyword-warning',
            'added': 'keyword-added',
            'deleted': 'keyword-deleted',
            'updated': 'keyword-updated'
        };

        Object.entries(keywords).forEach(([keyword, className]) => {
            const regex = new RegExp(`\\b(${keyword})\\b`, 'gi');
            message = message.replace(regex, `<span class="${className}">$1</span>`);
        });

        return message;
    }

    // 过滤调试日志
    filterDebugLogs(filter) {
        this.displayDebugLogs(filter);
    }

    // 清空调试日志
    clearDebugLogs() {
        const logsContainer = document.getElementById('debugLogs');
        if (logsContainer) {
            logsContainer.innerHTML = '';
        }

        if (window.debugLogger) {
            window.debugLogger.clearLogs();
        }
    }

    // 刷新调试信息
    refreshDebugInfo() {
        const panel = document.querySelector('.debug-panel');
        if (panel) {
            const stats = panel.querySelector('.debug-stats');
            if (stats) {
                stats.innerHTML = `
                    <p><strong>Sessions:</strong> <span>${this.sessions.length}</span></p>
                    <p><strong>Invalid:</strong> <span>${Object.keys(this.invalidAccounts).length}</span></p>
                    <p><strong>Selected:</strong> <span>${this.selectedIndices.size}</span></p>
                    <p><strong>Pending:</strong> <span>${this.pendingDeletes.size}</span></p>
                `;
            }

            const activeFilter = document.querySelector('.debug-filter.active')?.dataset.filter || 'all';
            this.displayDebugLogs(activeFilter);
        }
    }

    // 导出调试日志
    exportDebugLog() {
        const timestamp = new Date();
        const logs = window.debugLogger ?
            window.debugLogger.getLogs(null, this.infoLoggingEnabled) : [];

        // 收集系统信息
        const systemInfo = {
            exportTime: timestamp.toISOString(),
            exportTimeLocal: timestamp.toLocaleString(),
            userAgent: navigator.userAgent,
            platform: navigator.userAgentData?.platform || navigator.platform,
            language: navigator.language,
            screenResolution: `${screen.width}x${screen.height}`,
            windowSize: `${window.innerWidth}x${window.innerHeight}`,
            debugMode: this.debugMode,
            infoLoggingEnabled: this.infoLoggingEnabled
        };

        // 收集统计信息
        const stats = {
            totalSessions: this.sessions.length,
            invalidAccounts: Object.keys(this.invalidAccounts).length,
            selectedIndices: this.selectedIndices.size,
            pendingDeletes: this.pendingDeletes.size,
            totalLogs: logs.length,
            errorCount: logs.filter(l => l.type === 'error').length,
            warningCount: logs.filter(l => l.type === 'warn').length,
            logCount: logs.filter(l => l.type === 'log').length,
            infoCount: logs.filter(l => l.type === 'info').length
        };

        // 分析日志
        const logAnalysis = this.analyzeDebugLogs(logs);

        // 组装导出数据
        const exportData = {
            systemInfo,
            stats,
            analysis: logAnalysis,
            operationLog: this.operationLog.slice(-100), // 最近100条操作
            logs: logs,
            sessions: this.sessions.map((s, index) => ({
                index,
                email: s.email || '未知',
                cookieLength: s.cookie.length,
                isInvalid: !!this.invalidAccounts[s.email]
            }))
        };

        const jsonString = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonString], {type: 'application/json;charset=utf-8'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cookie-manager-debug-${timestamp.getTime()}.json`;
        a.click();
        URL.revokeObjectURL(url);

        UI.showSuccess('调试日志已导出');
    }

    // 分析日志
    analyzeDebugLogs(logs) {
        const analysis = {
            timeRange: {
                start: logs.length > 0 ? logs[0].timestamp : null,
                end: logs.length > 0 ? logs[logs.length - 1].timestamp : null
            },
            categories: {},
            errorPatterns: {},
            operationSummary: {}
        };

        // 分析日志分类
        logs.forEach(log => {
            // 提取分类
            const categoryMatch = log.message.match(/\[([^\]]+)\]/);
            const category = categoryMatch ? categoryMatch[1] : 'Unknown';

            if (!analysis.categories[category]) {
                analysis.categories[category] = {
                    count: 0,
                    types: {}
                };
            }

            analysis.categories[category].count++;
            analysis.categories[category].types[log.type] =
                (analysis.categories[category].types[log.type] || 0) + 1;

            // 分析错误模式
            if (log.type === 'error') {
                const errorKey = log.message.substring(0, 50);
                analysis.errorPatterns[errorKey] =
                    (analysis.errorPatterns[errorKey] || 0) + 1;
            }
        });

        // 分析操作
        this.operationLog.forEach(op => {
            analysis.operationSummary[op.action] =
                (analysis.operationSummary[op.action] || 0) + 1;
        });

        return analysis;
    }
}

// 初始化
let cookieManager;
document.addEventListener('DOMContentLoaded', () => {
    cookieManager = new CookieManager();
});