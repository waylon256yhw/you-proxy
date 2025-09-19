/**
 * 认证页面
 */

// 全局错误处理
window.addEventListener('error', function(event) {
    console.error('Script error:', event);
});
window.handleLogin = handleLogin;
window.handleSetupPassword = handleSetupPassword;
window.togglePasswordVisibility = togglePasswordVisibility;

// 密码可见性切换
function togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    const button = input.nextElementSibling;
    const icon = button.querySelector('i');
    
    if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'icon-eye-off';
    } else {
        input.type = 'password';
        icon.className = 'icon-eye';
    }
}

// 密码强度检查
function checkPasswordStrength(password) {
    let strength = 0;
    
    if (password.length >= 8) strength++;
    if (password.length >= 12) strength++;
    if (/[a-z]/.test(password)) strength++;
    if (/[A-Z]/.test(password)) strength++;
    if (/[0-9]/.test(password)) strength++;
    if (/[^a-zA-Z0-9]/.test(password)) strength++;
    
    const strengthFill = document.getElementById('strengthFill');
    const strengthText = document.getElementById('strengthText');
    
    if (strength <= 2) {
        strengthFill.className = 'strength-fill weak';
        strengthText.textContent = '密码强度：弱';
        strengthText.style.color = 'var(--auth-danger)';
    } else if (strength <= 4) {
        strengthFill.className = 'strength-fill medium';
        strengthText.textContent = '密码强度：中';
        strengthText.style.color = 'var(--auth-warning)';
    } else {
        strengthFill.className = 'strength-fill strong';
        strengthText.textContent = '密码强度：强';
        strengthText.style.color = 'var(--auth-success)';
    }
}

// 防止重复提交
let isSubmitting = false;

// 处理登录
async function handleLogin() {
    if (isSubmitting) return;

    const passwordInput = document.getElementById('password');
    const password = passwordInput.value.trim();
    const errorDiv = document.getElementById('loginError');
    const button = document.querySelector('#loginForm .btn-auth');
    
    // 清除错误
    errorDiv.style.display = 'none';
    errorDiv.textContent = '';
    errorDiv.classList.remove('error-critical');

    if (!password) {
        showError('请输入密码', 'loginError');
        return;
    }
    
    // 设置提交
    isSubmitting = true;

    // 显示加载状态
    setButtonLoading(button, true);
    
    try {
        const response = await fetch('/cookie-manager/auth/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            if (data.needsPasswordChange) {
                document.getElementById('loginForm').style.display = 'none';
                document.getElementById('setupForm').style.display = 'block';
                // 聚焦
                document.getElementById('newPassword').focus();
            } else {
                if (data.sessionId) {
                    localStorage.setItem('cm_session', data.sessionId);
                    document.cookie = `cm_session=${data.sessionId}; path=/; max-age=86400`;
                }
                window.location.href = '/cookie-manager/';
            }
        } else {
            if (data.critical) {
                errorDiv.classList.add('error-critical');
            }
            showError(data.error || '登录失败', 'loginError');
            
            // 震动输入框
            passwordInput.classList.add('shake');
            setTimeout(() => passwordInput.classList.remove('shake'), 500);
        }
    } catch (error) {
        showError('网络错误，请重试', 'loginError');
    } finally {
        setButtonLoading(button, false);
        // 重置提交
        isSubmitting = false;
    }
}

// 处理设置密码
async function handleSetupPassword() {
    if (isSubmitting) return;

    const newPasswordInput = document.getElementById('newPassword');
    const confirmPasswordInput = document.getElementById('confirmPassword');
    const newPassword = newPasswordInput.value;
    const confirmPassword = confirmPasswordInput.value;
    const errorDiv = document.getElementById('setupError');
    const button = document.querySelector('#setupForm .btn-auth');
    
    // 清除错误
    errorDiv.style.display = 'none';
    errorDiv.textContent = '';
    
    // 验证
    if (!newPassword || !confirmPassword) {
        showError('请填写所有字段', 'setupError');
        return;
    }
    
    if (newPassword.length < 8) {
        showError('密码长度至少为8位', 'setupError');
        return;
    }
    
    if (newPassword !== confirmPassword) {
        showError('两次输入的密码不一致', 'setupError');
        return;
    }
    // 设置提交
    isSubmitting = true;

    // 显示加载状态
    setButtonLoading(button, true);
    
    try {
        const response = await fetch('/cookie-manager/auth/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ newPassword })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // 显示成功
            document.getElementById('setupForm').style.display = 'none';
            document.getElementById('successMessage').style.display = 'block';
            
            // 2秒刷新
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } else {
            showError(data.error || '设置密码失败', 'setupError');
        }
    } catch (error) {
        showError('网络错误，请重试', 'setupError');
    } finally {
        setButtonLoading(button, false);
        // 重置提交
        isSubmitting = false;
    }
}

// 显示错误
function showError(message, elementId) {
    const errorDiv = document.getElementById(elementId);
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
}

// 设置按钮加载状态
function setButtonLoading(button, loading) {
    const textSpan = button.querySelector('.btn-text');
    const loadingSpan = button.querySelector('.btn-loading');
    
    if (loading) {
        textSpan.style.display = 'none';
        loadingSpan.style.display = 'block';
        button.disabled = true;
    } else {
        textSpan.style.display = 'block';
        loadingSpan.style.display = 'none';
        button.disabled = false;
    }
}

// 监听密码强度
document.getElementById('newPassword')?.addEventListener('input', (e) => {
    checkPasswordStrength(e.target.value);
});

// 清理旧session cookie
document.addEventListener('DOMContentLoaded', function() {
    const cookies = document.cookie.split(';');
    for (let cookie of cookies) {
        const [key, value] = cookie.trim().split('=');
        if (key === 'cm_session' && value) {
            fetch('/cookie-manager/api/health', {
                headers: {
                    'X-Session-Id': value
                }
            }).then(response => {
                if (response.status === 401) {
                    // Session无效
                    document.cookie = 'cm_session=; path=/; max-age=0';
                    console.log('Cleared invalid session');
                }
            }).catch(() => {
                document.cookie = 'cm_session=; path=/; max-age=0';
            });
        }
    }

    // 绑定事件和初始化
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && loginForm.style.display !== 'none') {
                e.preventDefault();
                handleLogin();
            }
        });
    }
    const setupForm = document.getElementById('setupForm');
    if (setupForm) {
        setupForm.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && setupForm.style.display !== 'none') {
                e.preventDefault();
                handleSetupPassword();
            }
        });
    }

    const passwordInput = document.getElementById('password');
    if (passwordInput && loginForm && loginForm.style.display !== 'none') {
        passwordInput.focus();
    }
});

console.log('Auth.js loaded successfully');

// 输入框震动
const style = document.createElement('style');
style.textContent = `
    @keyframes shake {
        0%, 100% { transform: translateX(0); }
        25% { transform: translateX(-5px); }
        75% { transform: translateX(5px); }
    }
    .shake {
        animation: shake 0.5s;
    }
`;
document.head.appendChild(style);