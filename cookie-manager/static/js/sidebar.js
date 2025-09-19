/**
 * 左侧侧边栏管理器
 */
class SidebarManager {
    constructor() {
        this.isOpen = false;
        this.currentFile = null;
        this.originalContent = {};
        this.originalValues = {};
        this.modifiedValues = {};
        this.editMode = 'input'; // 'input' or 'editor'
        this.hasUnsavedChanges = false;
        this.availableFiles = [];
        this.pendingSaveIds = [];
        this.editorFontSize = this.getEditorFontSize() || 13; // 13px
        this.terminalWindow = null; // 终端窗口
        this.terminalSocket = null; // WebSocket
        this.init();
    }

    init() {
        this.createSidebar();
        this.bindEvents();
        this.checkAvailableFiles();
        this.logOperation('SIDEBAR_INIT', { timestamp: new Date().toISOString() });
    }

    // 获取保存字体大小
    getEditorFontSize() {
        const saved = localStorage.getItem('configEditorFontSize');
        return saved ? parseInt(saved) : 13;
    }

    // 保存字体大小
    saveEditorFontSize(size) {
        localStorage.setItem('configEditorFontSize', size);
    }

    // 侧边栏HTML
    createSidebar() {
        // 触发按钮
        const trigger = document.createElement('button');
        trigger.className = 'sidebar-trigger';
        trigger.id = 'sidebarTrigger';
        trigger.innerHTML = '<i class="icon-menu"></i>';
        trigger.title = '打开侧边栏';
        document.body.appendChild(trigger);

        // 遮罩层
        const overlay = document.createElement('div');
        overlay.className = 'sidebar-overlay';
        overlay.id = 'sidebarOverlay';
        document.body.appendChild(overlay);

        // 侧边栏
        const sidebar = document.createElement('div');
        sidebar.className = 'left-sidebar';
        sidebar.id = 'leftSidebar';
        sidebar.innerHTML = `
            <div class="sidebar-header">
                <div class="sidebar-title">
                    <h2><i class="icon-menu"></i> 控制面板</h2>
                    <button class="sidebar-close" id="sidebarClose">
                        <i class="icon-close"></i>
                    </button>
                </div>
                <div class="sidebar-actions">
                    <button class="restart-button" id="restartButton">
                        <span class="text"><i class="icon-restart"></i> 重启服务</span>
                        <span class="spinner"></span>
                    </button>
                    <button class="terminal-button" id="terminalButton">
                        <i class="icon-terminal"></i> 终端
                    </button>
                </div>
            </div>
            
            <div class="config-tabs" id="configTabs">
                <!-- 动态添加 -->
            </div>
            
            <div class="sidebar-content-wrapper">
                <div class="editor-controls" id="editorControls" style="display: none;">
                    <button class="font-size-btn" id="fontSizeDecrease" title="减小字体">
                        <i class="icon-minus"></i>
                    </button>
                    <span class="font-size-display" id="fontSizeDisplay">13px</span>
                    <button class="font-size-btn" id="fontSizeIncrease" title="增大字体">
                        <i class="icon-plus"></i>
                    </button>
                </div>
                <div class="sidebar-content" id="sidebarContent">
                    <div class="empty-state">
                        <i class="icon-empty"></i>
                        <p>正在加载配置文件...</p>
                    </div>
                </div>
            </div>
            
            <div class="sidebar-footer">
                <div class="mode-toggle">
                    <button class="mode-btn active" data-mode="input">
                        <i class="icon-input"></i> 输入模式
                    </button>
                    <button class="mode-btn" data-mode="editor">
                        <i class="icon-editor"></i> 编辑模式
                    </button>
                </div>
                <div class="action-buttons">
                    <button class="btn-reset" id="resetButton">
                        <i class="icon-reset"></i> 重置
                    </button>
                    <button class="btn-save" id="saveButton">
                        <i class="icon-save"></i> 保存
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(sidebar);

        this.logOperation('SIDEBAR_CREATED', { 
            elements: ['trigger', 'overlay', 'sidebar'] 
        });
    }

    // 绑定事件
    bindEvents() {
        // 打开侧边栏
        document.getElementById('sidebarTrigger').addEventListener('click', () => {
            this.open();
        });

        // 关闭按钮
        document.getElementById('sidebarClose').addEventListener('click', () => {
            this.close();
        });

        // 点击遮罩层关闭
        document.getElementById('sidebarOverlay').addEventListener('click', () => {
            this.checkAndClose();
        });

        // 重启按钮
        document.getElementById('restartButton').addEventListener('click', () => {
            this.handleRestart();
        });

        // 重置按钮
        document.getElementById('resetButton').addEventListener('click', () => {
            this.resetChanges();
        });

        // 终端按钮
        document.getElementById('terminalButton').addEventListener('click', () => {
            this.toggleTerminal();
        });

        // 字体大小控制
        document.getElementById('fontSizeIncrease').addEventListener('click', () => {
            this.changeFontSize(1);
        });

        document.getElementById('fontSizeDecrease').addEventListener('click', () => {
            this.changeFontSize(-1);
        });

        // 模式切换
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchMode(btn.dataset.mode);
            });
        });

        // 保存按钮
        document.getElementById('saveButton').addEventListener('click', () => {
            this.saveConfig();
        });

        // ESC键关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.checkAndClose();
            }
        });

        this.logOperation('SIDEBAR_EVENTS_BOUND', { 
            events: ['click', 'keydown'] 
        });
    }

    // 重置
    async resetChanges() {
        if (!this.hasUnsavedChanges) {
            UI.showInfo('没有需要重置的更改');
            return;
        }

        // 清空修改
        this.modifiedValues = {};
        this.hasUnsavedChanges = false;
        if (this.currentFile) {
            await this.loadConfig(this.currentFile);
        }

        // 清除所有修改标记
        document.querySelectorAll('.config-input.modified').forEach(input => {
            input.classList.remove('modified');
        });
        document.querySelectorAll('.config-checkbox-wrapper.modified').forEach(cb => {
            cb.classList.remove('modified');
        });

        this.updateStatusIndicator();
        UI.showSuccess('已重置所有更改');

        this.logOperation('RESET_CHANGES', {
            file: this.currentFile
        });
    }

    // 字体大小
    changeFontSize(delta) {
        this.editorFontSize = Math.max(10, Math.min(24, this.editorFontSize + delta));
        this.saveEditorFontSize(this.editorFontSize);

        const editor = document.getElementById('codeEditor');
        if (editor) {
            editor.style.fontSize = `${this.editorFontSize}px`;
        }

        document.getElementById('fontSizeDisplay').textContent = `${this.editorFontSize}px`;

        this.logOperation('FONT_SIZE_CHANGED', {
            fontSize: this.editorFontSize
        });
    }

    // 切换终端
    toggleTerminal() {
        if (this.terminalWindow) {
            this.closeTerminal();
        } else {
            this.openTerminal();
        }
    }

    // 打开终端
    openTerminal() {
        const terminal = document.createElement('div');
        terminal.className = 'terminal-window';
        terminal.id = 'terminalWindow';
        terminal.innerHTML = `
            <div class="terminal-header">
                <div class="terminal-title">
                    <i class="icon-terminal"></i> 终端输出
                </div>
                <div class="terminal-controls">
                    <button class="terminal-btn" onclick="sidebarManager.clearTerminal()" title="清空">
                        <i class="icon-clear"></i>
                    </button>
                    <button class="terminal-btn terminal-autoscroll active" onclick="sidebarManager.toggleAutoScroll()" title="自动滚动">
                        <i class="icon-autoscroll"></i>
                    </button>
                    <button class="terminal-btn terminal-close" onclick="sidebarManager.closeTerminal()">
                        <i class="icon-close"></i>
                    </button>
                </div>
            </div>
            <div class="terminal-content" id="terminalContent">
                <div class="terminal-output" id="terminalOutput">
                    <div class="terminal-welcome">正在连接终端...</div>
                </div>
            </div>
            <div class="terminal-resize-handle"></div>
        `;
        document.body.appendChild(terminal);

        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const terminalWidth = 800;
        const terminalHeight = 500;
        terminal.style.width = `${terminalWidth}px`;
        terminal.style.height = `${terminalHeight}px`;
        terminal.style.left = `${(windowWidth - terminalWidth) / 2}px`;
        terminal.style.top = `${(windowHeight - terminalHeight) / 2}px`;
        // 清除 transform
        terminal.style.transform = 'none';

        this.terminalWindow = terminal;
        this.makeTerminalDraggable();
        this.makeTerminalResizable();
        this.connectTerminal();

        // 自动滚动
        this.autoScroll = true;

        this.logOperation('TERMINAL_OPENED', {
            timestamp: new Date().toISOString()
        });
    }

    // 关闭终端
    closeTerminal() {
        if (this.terminalWindow) {
            this.terminalWindow.remove();
            this.terminalWindow = null;
        }

        if (this.terminalSocket) {
            this.terminalSocket.close();
            this.terminalSocket = null;
        }

        this.logOperation('TERMINAL_CLOSED', {
            timestamp: new Date().toISOString()
        });
    }

    // 连接终端WebSocket
    connectTerminal() {
        const sessionId = this.getSessionId();
        if (!sessionId) {
            this.addTerminalOutput('✗ 未登录，无法连接终端', 'error');
            return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/cookie-manager/api/terminal/ws?session=${sessionId}`;

        try {
            this.terminalSocket = new WebSocket(wsUrl);

            this.terminalSocket.onopen = () => {
                this.addTerminalOutput('✓ 终端已连接', 'success');
            };

            this.terminalSocket.onmessage = (event) => {
                this.addTerminalOutput(event.data);
            };

            this.terminalSocket.onerror = (error) => {
                if (error.code === 401) {
                    this.addTerminalOutput('✗ 认证失败，请重新登录', 'error');
                    setTimeout(() => {
                        window.location.href = '/cookie-manager/auth';
                    }, 2000);
                } else {
                    this.addTerminalOutput('✗ 连接错误', 'error');
                }
            };

            this.terminalSocket.onclose = () => {
                this.addTerminalOutput('⚠ 连接已断开', 'warning');
                this.terminalSocket = null;
            };
        } catch (error) {
            this.addTerminalOutput('✗ 无法连接到终端', 'error');
        }
    }

    // 终端输出
    addTerminalOutput(text, type = 'normal') {
        const output = document.getElementById('terminalOutput');
        if (!output) return;

        const line = document.createElement('div');
        line.className = 'terminal-line';

        if (text.includes('[LOG]')) {
            line.className += ' terminal-log';
        } else if (text.includes('[ERROR]')) {
            line.className += ' terminal-error';
            text = text.replace('[ERROR]', '<span class="log-badge">[ERROR]</span>');
        } else if (text.includes('[WARN]')) {
            line.className += ' terminal-warning';
            text = text.replace('[WARN]', '<span class="log-badge">[WARN]</span>');
        } else if (text.includes('[INFO]')) {
            line.className += ' terminal-info';
            text = text.replace('[INFO]', '<span class="log-badge">[INFO]</span>');
        } else if (text.includes('[DEBUG]')) {
            line.className += ' terminal-debug';
            text = text.replace('[DEBUG]', '<span class="log-badge">[DEBUG]</span>');
        } else if (type) {
            line.className += ` terminal-${type}`;
        }

        line.innerHTML = this.escapeHtmlExceptSpan(text);
        output.appendChild(line);

        // 自动滚动
        if (this.autoScroll) {
            const content = document.getElementById('terminalContent');
            content.scrollTop = content.scrollHeight;
        }

        // 限制历史行数
        while (output.children.length > 2000) {
            output.removeChild(output.firstChild);
        }
    }

    // 转义HTML保留span
    escapeHtmlExceptSpan(text) {
        const div = document.createElement('div');
        div.textContent = text;

        let escaped = div.innerHTML;
        escaped = escaped.replace(/&lt;span class="log-badge"&gt;/g, '<span class="log-badge">');
        escaped = escaped.replace(/&lt;\/span&gt;/g, '</span>');

        return escaped;
    }

    // 清空终端
    clearTerminal() {
        const output = document.getElementById('terminalOutput');
        if (output) {
            output.innerHTML = '<div class="terminal-line terminal-info">终端已清空</div>';
        }
    }

    // 切换自动滚动
    toggleAutoScroll() {
        this.autoScroll = !this.autoScroll;
        const btn = document.querySelector('.terminal-autoscroll');
        if (btn) {
            if (this.autoScroll) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
        UI.showInfo(this.autoScroll ? '已开启自动滚动' : '已关闭自动滚动');
    }

    // 终端可拖动
    makeTerminalDraggable() {
        const terminal = this.terminalWindow;
        const header = terminal.querySelector('.terminal-header');
        let isDragging = false;
        let initialMouseX = 0;
        let initialMouseY = 0;
        let initialWindowX = 0;
        let initialWindowY = 0;

        header.addEventListener('mousedown', dragStart);

        function dragStart(e) {
            if (e.target.closest('.terminal-controls')) return;

            // 记录鼠标初始位置
            initialMouseX = e.clientX;
            initialMouseY = e.clientY;

            initialWindowX = terminal.offsetLeft;
            initialWindowY = terminal.offsetTop;

            isDragging = true;
            terminal.classList.add('dragging');

            // 阻止文本选择
            e.preventDefault();

            document.addEventListener('mousemove', drag);
            document.addEventListener('mouseup', dragEnd);
        }

        function drag(e) {
            if (!isDragging) return;

            e.preventDefault();

            const deltaX = e.clientX - initialMouseX;
            const deltaY = e.clientY - initialMouseY;

            // 计算新位置
            const newX = initialWindowX + deltaX;
            const newY = initialWindowY + deltaY;

            terminal.style.left = `${newX}px`;
            terminal.style.top = `${newY}px`;
        }

        function dragEnd() {
            isDragging = false;
            terminal.classList.remove('dragging');
            document.removeEventListener('mousemove', drag);
            document.removeEventListener('mouseup', dragEnd);
        }
    }

    // 终端调整大小
    makeTerminalResizable() {
        const terminal = this.terminalWindow;
        const handle = terminal.querySelector('.terminal-resize-handle');
        let isResizing = false;
        let startX = 0;
        let startY = 0;
        let startWidth = 0;
        let startHeight = 0;

        handle.addEventListener('mousedown', resizeStart);

        function resizeStart(e) {
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startWidth = terminal.offsetWidth;
            startHeight = terminal.offsetHeight;

            terminal.classList.add('resizing');
            document.addEventListener('mousemove', resize);
            document.addEventListener('mouseup', resizeEnd);
        }

        function resize(e) {
            if (!isResizing) return;

            const width = startWidth + e.clientX - startX;
            const height = startHeight + e.clientY - startY;

            terminal.style.width = `${Math.max(400, width)}px`;
            terminal.style.height = `${Math.max(300, height)}px`;
        }

        function resizeEnd() {
            isResizing = false;
            terminal.classList.remove('resizing');
            document.removeEventListener('mousemove', resize);
            document.removeEventListener('mouseup', resizeEnd);
        }
    }

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
    }

    // 检查可用配置
    async checkAvailableFiles() {
        const sessionId = this.getSessionId();
        if (!sessionId) {
            UI.showError('未登录，请刷新页面重新登录');
            window.location.href = '/cookie-manager/auth';
            return;
        }

        try {
            const response = await fetch('/cookie-manager/api/config/files', {
                headers: {
                    'X-Session-Id': sessionId
                }
            });

            if (response.status === 401) {
                UI.showError('会话已过期，请重新登录');
                window.location.href = '/cookie-manager/auth';
                return;
            }

            const data = await response.json();

            if (data.success) {
                this.availableFiles = data.files;
                this.renderTabs();

                // 加载第一个
                if (this.availableFiles.length > 0) {
                    await this.loadConfig(this.availableFiles[0]);
                }
            }
        } catch (error) {
            this.logOperation('CONFIG_FILES_ERROR', { error: error.message });
            this.showEmptyState();
        }
    }

    // 渲染选项卡
    renderTabs() {
        const tabsContainer = document.getElementById('configTabs');
        tabsContainer.innerHTML = '';

        if (this.availableFiles.length === 0) {
            tabsContainer.style.display = 'none';
            return;
        }

        tabsContainer.style.display = 'flex';

        this.availableFiles.forEach((file, index) => {
            const tab = document.createElement('button');
            tab.className = 'config-tab';
            if (index === 0) tab.classList.add('active');

            // 显示名称
            const displayName = file === 'start.bat' ? 'Windows (BAT)' : 'Linux/Mac (SH)';
            tab.innerHTML = `<i class="icon-file"></i> ${displayName}`;
            tab.dataset.file = file;

            tab.addEventListener('click', () => {
                if (this.currentFile !== file) {
                    if (this.hasUnsavedChanges) {
                        this.confirmSwitchTab(file);
                    } else {
                        this.loadConfig(file);
                    }
                }
            });

            tabsContainer.appendChild(tab);
        });
    }

    // 确认切换标签
    async confirmSwitchTab(file) {
        const confirmed = await UI.confirm('有未保存的更改，是否保存？');
        if (confirmed) {
            await this.saveConfig();
        }
        await this.loadConfig(file);
    }

    // 加载配置文件
    async loadConfig(filename) {
        const sessionId = this.getSessionId();
        if (!sessionId) {
            UI.showError('未登录，请刷新页面重新登录');
            window.location.href = '/cookie-manager/auth';
            return;
        }
        try {
            UI.showLoading();

            const response = await fetch(`/cookie-manager/api/config/load?file=${filename}`, {
                headers: {
                    'X-Session-Id': sessionId
                }
            });

            if (response.status === 401) {
                UI.showError('会话已过期，请重新登录');
                window.location.href = '/cookie-manager/auth';
                return;
            }

            const data = await response.json();

            if (data.success) {
                this.currentFile = filename;
                this.originalContent[filename] = data.content;
                this.modifiedValues = {};
                this.hasUnsavedChanges = false;

                // 存储原始值
                this.originalValues = {};
                data.variables.forEach(variable => {
                    this.originalValues[variable.name] = variable.value;
                });

                // 更新标签状态
                document.querySelectorAll('.config-tab').forEach(tab => {
                    tab.classList.toggle('active', tab.dataset.file === filename);
                });

                // 根据当前模式渲染内容
                if (this.editMode === 'input') {
                    this.renderInputMode(data.variables);
                } else {
                    this.renderEditorMode(data.content);
                }

                this.logOperation('CONFIG_LOADED', { file: filename, mode: this.editMode });
            } else {
                UI.showError('加载配置文件失败');
            }
        } catch (error) {
            this.logOperation('CONFIG_LOAD_ERROR', { error: error.message });
            UI.showError('加载配置文件失败');
        } finally {
            UI.hideLoading();
        }
    }

    isBooleanValue(value) {
        return value === 'true' || value === 'false';
    }

    // 渲染输入模式
    renderInputMode(variables) {
        const content = document.getElementById('sidebarContent');
        content.innerHTML = '';

        if (variables.length === 0) {
            content.innerHTML = `
                <div class="empty-state">
                    <i class="icon-empty"></i>
                    <p>没有找到环境变量</p>
                </div>
            `;
            return;
        }

        const container = document.createElement('div');
        container.className = 'config-items';

        variables.forEach(variable => {
            const item = document.createElement('div');
            item.className = 'config-item';
            item.dataset.variable = variable.name;

            // 构建HTML
            let html = '';

            // 注释
            if (variable.comment) {
                html += `<div class="config-comment">${this.escapeHtml(variable.comment)}</div>`;
            }

            // 变量名和值
            html += `<div class="config-variable">`;
            html += `<div class="config-name">${variable.name}</div>`;
            html += `<div class="config-value">`;

            // 判断布尔
            if (this.isBooleanValue(variable.value)) {
                const checked = variable.value === 'true' ? 'checked' : '';
                const statusText = variable.value === 'true' ? 'true' : 'false';
                html += `
                    <div class="config-checkbox-wrapper" data-variable="${variable.name}">
                        <label class="config-checkbox-label">
                            <input type="checkbox" 
                                   class="config-checkbox-input" 
                                   data-variable="${variable.name}"
                                   data-type="boolean"
                                   ${checked}>
                            <span class="config-checkbox-box"></span>
                        </label>
                        <span class="config-boolean-status">${statusText}</span>
                    </div>
                `;
            } else {
                // 使用输入框
                const originalValue = this.originalValues[variable.name];
                const currentValue = variable.value || '';
                let placeholder = '空值';

                if (currentValue === '' && originalValue !== undefined && originalValue !== '') {
                    placeholder = `原始值: ${originalValue}`;
                } else if (currentValue === '' && (originalValue === undefined || originalValue === '')) {
                    placeholder = '空值';
                }

                html += `
                    <input type="text" 
                           class="config-input" 
                           data-variable="${variable.name}"
                           data-type="text"
                           value="${this.escapeHtml(currentValue)}"
                           placeholder="${this.escapeHtml(placeholder)}"
                           data-original="${this.escapeHtml(originalValue || '')}">
                `;
            }

            html += `</div></div>`;

            item.innerHTML = html;
            container.appendChild(item);

            // 绑定事件
            const checkboxInput = item.querySelector('.config-checkbox-input');
            if (checkboxInput) {
                checkboxInput.addEventListener('change', (e) => {
                    const value = e.target.checked ? 'true' : 'false';
                    const statusSpan = e.target.closest('.config-checkbox-wrapper').querySelector('.config-boolean-status');
                    if (statusSpan) {
                        statusSpan.textContent = value;
                    }
                    this.handleInputChange(variable.name, value, variable.value);
                });
            }

            const textInput = item.querySelector('.config-input');
            if (textInput) {
                textInput.addEventListener('input', (e) => {
                    // 动态更新
                    const originalValue = e.target.dataset.original;
                    if (e.target.value === '' && originalValue) {
                        e.target.placeholder = `原始值: ${originalValue}`;
                    } else if (e.target.value === '') {
                        e.target.placeholder = '空值';
                    }
                    this.handleInputChange(variable.name, e.target.value, variable.value);
                });
                textInput.addEventListener('focus', (e) => {
                    if (e.target.value === '' && e.target.dataset.original) {
                        e.target.placeholder = `原始值: ${e.target.dataset.original}`;
                    }
                });

                textInput.addEventListener('blur', (e) => {
                    if (e.target.value === '' && e.target.dataset.original) {
                        e.target.placeholder = `原始值: ${e.target.dataset.original}`;
                    } else if (e.target.value === '') {
                        e.target.placeholder = '空值';
                    }
                });
            }
        });

        content.appendChild(container);
    }

    // 渲染编辑器模式
    renderEditorMode(content) {
        const container = document.getElementById('sidebarContent');
        container.innerHTML = `
            <div class="config-editor">
                <textarea class="code-editor" id="codeEditor" style="font-size: ${this.editorFontSize}px">${this.escapeHtml(content)}</textarea>
            </div>
        `;

        // 绑定编辑事件
        const textarea = document.getElementById('codeEditor');
        textarea.addEventListener('input', () => {
            this.hasUnsavedChanges = true;
            this.updateStatusIndicator();
        });
    }

    // 切换模式
    switchMode(mode) {
        if (this.editMode === mode) return;

        // 更新按钮
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        this.editMode = mode;

        // 显示/隐藏字体控制
        const editorControls = document.getElementById('editorControls');
        if (mode === 'editor') {
            editorControls.style.display = 'flex';
            document.getElementById('fontSizeDisplay').textContent = `${this.editorFontSize}px`;
        } else {
            editorControls.style.display = 'none';
        }

        // 重新加载
        if (this.currentFile) {
            this.loadConfig(this.currentFile);
        }
    }

    // 处理输入变更
    handleInputChange(name, newValue, originalValue) {
        if (newValue !== originalValue) {
            this.modifiedValues[name] = newValue;
            const input = document.querySelector(`[data-variable="${name}"]`);
            if (input) {
                if (input.type === 'checkbox') {
                    input.closest('.config-checkbox-wrapper').classList.add('modified');
                } else {
                    input.classList.add('modified');
                }
            }
        } else {
            delete this.modifiedValues[name];
            // 移除修改标记
            const input = document.querySelector(`[data-variable="${name}"]`);
            if (input) {
                if (input.type === 'checkbox') {
                    input.closest('.config-checkbox-wrapper').classList.remove('modified');
                } else {
                    input.classList.remove('modified');
                }
            }
        }

        this.hasUnsavedChanges = Object.keys(this.modifiedValues).length > 0;
        this.updateStatusIndicator();
    }

    // 状态指示
    updateStatusIndicator() {
        const saveButton = document.getElementById('saveButton');
        if (saveButton) {
            if (this.hasUnsavedChanges) {
                saveButton.classList.add('has-changes');
                saveButton.innerHTML = '<i class="icon-save"></i> 保存 (有更改)';
            } else {
                saveButton.classList.remove('has-changes');
                saveButton.innerHTML = '<i class="icon-save"></i> 保存';
            }
        }
    }

    // 保存配置
    async saveConfig() {
        const sessionId = this.getSessionId();
        if (!sessionId) {
            UI.showError('未登录，请刷新页面重新登录');
            window.location.href = '/cookie-manager/auth';
            return;
        }

        if (!this.currentFile) return;

        try {
            let payload = {};

            if (this.editMode === 'input') {
                // 收集修改
                payload = {
                    file: this.currentFile,
                    mode: 'variables',
                    changes: this.modifiedValues
                };
            } else {
                // 获取编辑
                const editorContent = document.getElementById('codeEditor').value;
                payload = {
                    file: this.currentFile,
                    mode: 'full',
                    content: editorContent
                };
            }

            const response = await fetch('/cookie-manager/api/config/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Session-Id': sessionId
                },
                body: JSON.stringify(payload)
            });

            if (response.status === 401) {
                UI.showError('会话已过期，请重新登录');
                window.location.href = '/cookie-manager/auth';
                return;
            }

            const data = await response.json();

            if (data.success) {
                // 记录保存ID
                if (data.saveId) {
                    this.pendingSaveIds.push(data.saveId);
                }

                this.hasUnsavedChanges = false;
                this.modifiedValues = {};

                // 清除修改标记
                document.querySelectorAll('.config-input.modified').forEach(input => {
                    input.classList.remove('modified');
                });
                document.querySelectorAll('.config-checkbox-wrapper.modified').forEach(cb => {
                    cb.classList.remove('modified');
                });

                this.updateStatusIndicator();
                UI.showSuccess('配置已提交保存');
                await this.handleRestartWithCheck();

                this.logOperation('CONFIG_SAVED', { file: this.currentFile });
            } else {
                UI.showError('保存失败: ' + data.error);
            }
        } catch (error) {
            this.logOperation('CONFIG_SAVE_ERROR', { error: error.message });
            UI.showError('保存配置失败');
        }
    }

    // 重启
    async handleRestartWithCheck() {
        const sessionId = this.getSessionId();
        if (!sessionId) {
            UI.showError('未登录，请刷新页面重新登录');
            window.location.href = '/cookie-manager/auth';
            return;
        }

        if (this.pendingSaveIds.length > 0) {
            try {
                const checkResponse = await fetch('/cookie-manager/api/config/check-before-restart', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Session-Id': sessionId
                    },
                    body: JSON.stringify({ saveIds: this.pendingSaveIds })
                });

                if (checkResponse.status === 401) {
                    UI.showError('会话已过期，请重新登录');
                    window.location.href = '/cookie-manager/auth';
                    return;
                }

                const checkData = await checkResponse.json();

                if (!checkData.success) {
                    UI.showWarning(checkData.message || '配置尚未保存完成，请稍后再试');
                    return;
                }

                // 清空完成ID
                this.pendingSaveIds = [];
            } catch (error) {
                this.logOperation('RESTART_CHECK_ERROR', { error: error.message });
            }
        }

        // 重启
        await this.handleRestart();
    }

    // 检查并关闭
    async checkAndClose() {
        if (this.hasUnsavedChanges) {
            const save = await UI.confirm('有未保存的更改，是否保存？');
            if (save) {
                await this.saveConfig();
            }
        }
        this.close();
    }

    // 显示空状态
    showEmptyState() {
        const content = document.getElementById('sidebarContent');
        content.innerHTML = `
            <div class="empty-state">
                <i class="icon-empty"></i>
                <p>没有找到配置文件</p>
                <p style="font-size: 12px; color: #999;">请确保 start.bat 或 start.sh 文件存在</p>
            </div>
        `;
    }

    // HTML转义
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    // 打开侧边栏
    open() {
        this.isOpen = true;
        document.getElementById('leftSidebar').classList.add('open');
        document.getElementById('sidebarOverlay').classList.add('show');
        document.getElementById('sidebarTrigger').classList.add('active');
        document.body.style.overflow = 'hidden';
        
        // 重置状态
        this.hasUnsavedChanges = false;
        this.modifiedValues = {};
        this.updateStatusIndicator();

        // 重新检查配置文件
        this.checkAvailableFiles();

        this.logOperation('SIDEBAR_OPENED', {
            timestamp: new Date().toISOString() 
        });
    }

    // 关闭侧边栏
    close() {
        this.isOpen = false;
        document.getElementById('leftSidebar').classList.remove('open');
        document.getElementById('sidebarOverlay').classList.remove('show');
        document.getElementById('sidebarTrigger').classList.remove('active');
        document.body.style.overflow = '';
        
        this.logOperation('SIDEBAR_CLOSED', { 
            timestamp: new Date().toISOString() 
        });
    }

    // 处理重启
    async handleRestart() {
        const sessionId = this.getSessionId();
        if (!sessionId) {
            UI.showError('未登录，请刷新页面重新登录');
            window.location.href = '/cookie-manager/auth';
            return;
        }
        const confirmed = await UI.confirm('确定要重启服务吗？这将中断当前所有连接。');
        if (!confirmed) {
            this.logOperation('RESTART_CANCELLED', {
                reason: 'User cancelled'
            });
            return;
        }

        const button = document.getElementById('restartButton');
        button.classList.add('loading');
        button.disabled = true;

        this.logOperation('RESTART_INITIATED', { 
            timestamp: new Date().toISOString()
        });

        try {
            const response = await fetch('/cookie-manager/api/restart', {
                method: 'POST',
                headers: {
                    'X-Session-Id': sessionId
                }
            });

            if (response.status === 401) {
                UI.showError('会话已过期，请重新登录');
                window.location.href = '/cookie-manager/auth';
                return;
            }

            const data = await response.json();

            if (data.success) {
                this.logOperation('RESTART_SUCCESS', { 
                    message: data.message 
                });
                
                UI.showSuccess('重启命令已发送，服务正在重启...');

                setTimeout(() => {
                    this.checkConnection();
                }, 5000);
            } else {
                this.logOperation('RESTART_FAILED', { 
                    error: data.error 
                });
                UI.showError('重启失败: ' + data.error);
            }
        } catch (error) {
            this.logOperation('RESTART_ERROR', { 
                error: error.message,
                stack: error.stack 
            });
            UI.showError('重启服务失败');
        } finally {
            button.classList.remove('loading');
            button.disabled = false;
        }
    }

    // 检查连接
    async checkConnection() {
        const sessionId = this.getSessionId();
        let retries = 0;
        const maxRetries = 30;

        this.logOperation('CONNECTION_CHECK_START', { 
            maxRetries: maxRetries 
        });

        const checkInterval = setInterval(async () => {
            try {
                const response = await fetch('/cookie-manager/api/health', {
                    method: 'GET',
                    headers: {
                        'X-Session-Id': sessionId
                    }
                });

                if (response.ok) {
                    clearInterval(checkInterval);
                    this.logOperation('CONNECTION_RESTORED', { 
                        retries: retries 
                    });
                    UI.showSuccess('服务已重新启动');
                    window.location.reload();
                }
            } catch (error) {
                retries++;
                if (retries >= maxRetries) {
                    clearInterval(checkInterval);
                    this.logOperation('CONNECTION_CHECK_TIMEOUT', { 
                        retries: retries 
                    });
                    UI.showWarning('服务重启中，请稍后手动刷新页面');
                }
            }
        }, 2000);
    }

    // 日志
    logOperation(action, details = {}) {
        if (window.cookieManager && typeof window.cookieManager.logOperation === 'function') {
            window.cookieManager.logOperation(action, details);
        }
    }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    window.sidebarManager = new SidebarManager();
});