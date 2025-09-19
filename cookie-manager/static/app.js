let sessions = [];
let invalidAccounts = {};
let editingIndex = -1;

// 页面加载时获取数据
document.addEventListener('DOMContentLoaded', () => {
    refreshSessions();
});

// 刷新Sessions列表
async function refreshSessions() {
    try {
        const response = await fetch('/cookie-manager/api/sessions');
        const data = await response.json();

        if (data.success) {
            sessions = data.data.sessions;
            invalidAccounts = data.data.invalid_accounts;
            renderSessions();
            updateStats();
        } else {
            alert('获取数据失败: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('网络错误，重试');
    }
}

// 渲染Sessions表格
function renderSessions() {
    const tbody = document.getElementById('sessionsBody');
    tbody.innerHTML = '';

    sessions.forEach((session, index) => {
        // 优先后端解析，没有尝试前端解析
        const email = session.email || extractEmailFromCookie(session.cookie);
        const isInvalid = invalidAccounts[email];

        const row = document.createElement('tr');
        row.innerHTML = `
            <td><input type="checkbox" class="session-checkbox" data-index="${index}"></td>
            <td>${index + 1}</td>
            <td>${email || '未知'}</td>
            <td class="cookie-preview" title="${session.cookie}">${session.cookie.substring(0, 50)}...</td>
            <td>
                <span class="status ${isInvalid ? 'status-invalid' : 'status-active'}">
                    ${isInvalid || '有效'}
                </span>
            </td>
            <td class="actions">
                <button class="btn btn-sm" onclick="editSession(${index})">编辑</button>
                <button class="btn btn-danger btn-sm" onclick="deleteSession(${index})">删除</button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// 从Cookie中提取邮箱
function extractEmailFromCookie(cookie) {
    try {
        const dsMatch = cookie.match(/ds=([^;]+)/);
        if (dsMatch) {
            let dsToken = dsMatch[1];

            // 解码URL编码
            if (dsToken.includes('%')) {
                dsToken = decodeURIComponent(dsToken);
            }

            const parts = dsToken.split('.');
            if (parts.length >= 2) {
                // base64url解码
                let base64 = parts[1];
                // 转换base64url为标准base64
                base64 = base64.replace(/-/g, '+').replace(/_/g, '/');
                // 添加padding
                while (base64.length % 4) {
                    base64 += '=';
                }

                const payload = JSON.parse(atob(base64));
                console.log('Decoded payload:', payload); // 调试日志

                if (payload.email) {
                    return payload.email;
                }
            }
        }
    } catch (error) {
        console.error('提取邮箱失败:', error);
        console.error('Cookie:', cookie); // 添加调试信息
    }
    return null;
}

// 更新统计信息
function updateStats() {
    document.getElementById('totalCount').textContent = sessions.length;
    document.getElementById('invalidCount').textContent = Object.keys(invalidAccounts).length;
}

// 显示添加模态框
function showAddModal() {
    document.getElementById('addModal').style.display = 'block';
    document.getElementById('newCookie').value = '';
}

// 显示批量添加模态框
function showBatchAddModal() {
    document.getElementById('batchAddModal').style.display = 'block';
    document.getElementById('batchCookies').value = '';
}

// 关闭模态框
function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

// 添加单个Session
async function addSession() {
    const cookie = document.getElementById('newCookie').value.trim();

    if (!cookie) {
        alert('输入Cookie');
        return;
    }

    try {
        const validateResponse = await fetch('/cookie-manager/api/sessions/validate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({cookie})
        });

        const validateData = await validateResponse.json();

        if (validateData.success && !validateData.data.isValid) {
            alert('无效的Cookie格式，确保包含有效的ds字段');
            return;
        }

        if (validateData.success && !validateData.data.hasDsr) {
            if (!confirm('警告：该Cookie缺少DSR字段，可能无法正常使用。是否继续添加？')) {
                return;
            }
        }
    } catch (error) {
        console.error('验证失败:', error);
    }

    try {
        const response = await fetch('/cookie-manager/api/sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({cookie})
        });

        const data = await response.json();

        if (data.success) {
            closeModal('addModal');
            refreshSessions();
            alert(data.message);
        } else {
            alert('添加失败: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('网络错误，重试');
    }
}

// 批量添加Sessions
async function batchAddSessions() {
    const text = document.getElementById('batchCookies').value.trim();

    if (!text) {
        alert('输入Cookie');
        return;
    }

    const cookies = text.split('\n').map(line => line.trim()).filter(line => line);

    if (cookies.length === 0) {
        alert('没有有效的Cookie');
        return;
    }

    try {
        const response = await fetch('/cookie-manager/api/sessions/batch', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({cookies})
        });

        const data = await response.json();

        if (data.success) {
            closeModal('batchAddModal');
            refreshSessions();
            alert(data.message);
        } else {
            alert('添加失败: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('网络错误，重试');
    }
}

// 编辑Session
function editSession(index) {
    editingIndex = index;
    const session = sessions[index];
    document.getElementById('editCookie').value = session.cookie;
    document.getElementById('editModal').style.display = 'block';
}

// 更新Session
async function updateSession() {
    const cookie = document.getElementById('editCookie').value.trim();

    if (!cookie) {
        alert('输入Cookie');
        return;
    }

    try {
        const response = await fetch(`/cookie-manager/api/sessions/${editingIndex}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({cookie})
        });

        const data = await response.json();

        if (data.success) {
            closeModal('editModal');
            refreshSessions();
            alert(data.message);
        } else {
            alert('更新失败: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('网络错误，重试');
    }
}

// 删除Session
async function deleteSession(index) {
    if (!confirm('确定要删除这个Session吗？')) {
        return;
    }

    try {
        const response = await fetch(`/cookie-manager/api/sessions/${index}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            refreshSessions();
        } else {
            alert('删除失败: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('网络错误，重试');
    }
}

// 删除选中的Sessions
async function deleteSelected() {
    const checkboxes = document.querySelectorAll('.session-checkbox:checked');
    const indices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));

    if (indices.length === 0) {
        alert('先选择要删除的Session');
        return;
    }

    if (!confirm(`确定要删除选中的 ${indices.length} 个Session吗？`)) {
        return;
    }

    try {
        const response = await fetch('/cookie-manager/api/sessions/batch-delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({indices})
        });

        const data = await response.json();

        if (data.success) {
            refreshSessions();
            alert(data.message);
        } else {
            alert('删除失败: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('网络错误，重试');
    }
}

// 全选/取消全选
function toggleSelectAll() {
    const selectAll = document.getElementById('selectAll');
    const checkboxes = document.querySelectorAll('.session-checkbox');

    checkboxes.forEach(cb => {
        cb.checked = selectAll.checked;
    });
}

// 搜索过滤
function filterSessions() {
    const searchText = document.getElementById('searchInput').value.toLowerCase();
    const rows = document.querySelectorAll('#sessionsBody tr');

    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(searchText) ? '' : 'none';
    });
}

// 提取邮箱
async function extractEmails() {
    const checkboxes = document.querySelectorAll('.session-checkbox:checked');
    const selectedCookies = Array.from(checkboxes).map(cb => {
        const index = parseInt(cb.dataset.index);
        return sessions[index].cookie;
    });

    if (selectedCookies.length === 0) {
        selectedCookies.push(...sessions.map(s => s.cookie));
    }

    try {
        const response = await fetch('/cookie-manager/api/extract-emails', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({cookies: selectedCookies})
        });

        const data = await response.json();

        if (data.success) {
            const emails = data.data.join('\n');
            navigator.clipboard.writeText(emails).then(() => {
                alert(`已提取 ${data.data.length} 个邮箱地址并复制到剪贴板`);
            }).catch(() => {
                alert(`提取成功，手动复制:\n${emails}`);
            });
        }
    } catch (error) {
        console.error('Error:', error);
        alert('提取失败');
    }
}

// 添加调试按钮的点击处理
async function debugCookie() {
    if (sessions.length === 0) {
        alert('没有 Cookie 可调试');
        return;
    }

    // 获取第一个 session 的 cookie
    const firstSession = sessions[0];
    console.log('First session:', firstSession);
    console.log('Cookie:', firstSession.cookie);

    // 尝试本地解析
    const dsMatch = firstSession.cookie.match(/DS=([^;]+)/);
    if (dsMatch) {
        console.log('Found DS token:', dsMatch[1]);
        try {
            const parts = dsMatch[1].split('.');
            const payload = JSON.parse(atob(parts[1]));
            console.log('Decoded payload:', payload);
            console.log('Email:', payload.email);
        } catch (e) {
            console.error('Failed to decode:', e);
        }
    } else {
        console.log('No DS token found in cookie');
    }
}

// 模态框点击外部关闭
window.onclick = function (event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
}