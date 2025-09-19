import { spawn, exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { cookieDebugger } from './debugger.mjs';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 解析配置文件环境变量
 */
async function parseEnvironmentVariables() {
    const projectRoot = path.join(__dirname, '..');
    const isWindows = process.platform === 'win32';
    const configFile = isWindows ? 'start.bat' : 'start.sh';
    const configPath = path.join(projectRoot, configFile);

    const envVars = {};

    try {
        await fs.access(configPath);
        const content = await fs.readFile(configPath, 'utf-8');
        const lines = content.split(/\r?\n/);

        if (isWindows) {
            // 解析 BAT
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.toLowerCase().startsWith('set ')) {
                    const match = trimmed.match(/^set\s+([A-Z_][A-Z0-9_]*)=(.*)$/i);
                    if (match) {
                        envVars[match[1]] = match[2] || '';
                        cookieDebugger.log('Restart', `Parsed env var: ${match[1]}=${match[2]}`);
                    }
                }
            }
        } else {
            // 解析 SH
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.toLowerCase().startsWith('export ')) {
                    const match = trimmed.match(/^export\s+([A-Z_][A-Z0-9_]*)=(.*)$/i);
                    if (match) {
                        let value = match[2] || '';
                        // 移除引号
                        if ((value.startsWith('"') && value.endsWith('"')) ||
                            (value.startsWith("'") && value.endsWith("'"))) {
                            value = value.slice(1, -1);
                        }
                        envVars[match[1]] = value;
                        cookieDebugger.log('Restart', `Parsed env var: ${match[1]}=${value}`);
                    }
                }
            }
        }

        cookieDebugger.log('Restart', 'Environment variables parsed', {
            count: Object.keys(envVars).length,
            configFile: configFile
        });

    } catch (error) {
        cookieDebugger.error('Restart', 'Failed to parse config file', error);
    }

    return envVars;
}

/**
 * 重启服务API
 */
export function setupRestartAPI(router) {
    // 重启服务端点
    router.post('/api/restart', async (req, res) => {
        cookieDebugger.log('Restart', 'Restart request received');
        
        try {
            res.json({
                success: true,
                message: '重启命令已发送'
            });

            setTimeout(async () => {
                cookieDebugger.log('Restart', 'Preparing to restart service...');

                // 解析最新变量
                const customEnvVars = await parseEnvironmentVariables();

                // 合并
                const newEnv = {
                    ...process.env,  // 保留所有原始变量
                    ...customEnvVars  // 覆盖/添加自定义变量
                };

                cookieDebugger.log('Restart', 'Environment prepared', {
                    originalEnvCount: Object.keys(process.env).length,
                    customEnvCount: Object.keys(customEnvVars).length,
                    totalEnvCount: Object.keys(newEnv).length
                });

                const mainScript = path.join(__dirname, '..', 'index.mjs');
                const isWindows = process.platform === 'win32';

                cookieDebugger.log('Restart', 'Platform detected', {
                    platform: process.platform,
                    isWindows: isWindows,
                    script: mainScript
                });

                if (isWindows) {
                    const scriptDir = path.dirname(mainScript);
                    const nodePath = process.execPath;
                    const nodeArgs = '--expose-gc';
                    const command = `start "Cookie Manager" "${nodePath}" ${nodeArgs} "${mainScript}"`;

                    cookieDebugger.log('Restart', 'Windows restart command', {
                        command,
                        nodePath,
                        args: nodeArgs,
                        customEnvCount: Object.keys(customEnvVars).length
                    });

                    // exec 执行 start
                    exec(command, {
                        cwd: scriptDir,
                        env: newEnv,  // 使用最新变量
                        windowsHide: false,
                        shell: true
                    }, (error) => {
                        if (error) {
                            cookieDebugger.error('Restart', 'Failed to start new process', error);

                            const fallbackChild = spawn(nodePath, ['--expose-gc', mainScript], {
                                detached: true,
                                stdio: 'ignore',
                                cwd: scriptDir,
                                env: newEnv,
                                windowsHide: false
                            });

                            fallbackChild.unref();
                            cookieDebugger.log('Restart', 'Using fallback spawn method with new env');
                        }
                    });

                } else {
                    // Linux/Mac
                    const child = spawn(
                        process.execPath,
                        ['--expose-gc', mainScript],
                        {
                            detached: true,
                            stdio: 'inherit',
                            env: newEnv,
                            cwd: path.dirname(mainScript)
                        }
                    );

                    child.unref();

                    cookieDebugger.log('Restart', 'Linux/Mac process started with new env', {
                        customEnvCount: Object.keys(customEnvVars).length
                    });
                }

                // 记录当前进程
                cookieDebugger.log('Restart', 'Current process will exit', {
                    pid: process.pid,
                    platform: process.platform,
                    nodeVersion: process.version,
                    execPath: process.execPath
                });

                // 延迟退出
                setTimeout(() => {
                    cookieDebugger.log('Restart', 'Exiting current process...');

                    if (global.gc && typeof global.gc === 'function') {
                        try {
                            global.gc();
                            cookieDebugger.log('Restart', 'Garbage collection executed');
                        } catch (e) {
                            cookieDebugger.log('Restart', 'Garbage collection not available');
                        }
                    }

                    process.exit(0);
                }, 1500);

            }, 500);

        } catch (error) {
            cookieDebugger.error('Restart', 'Restart failed', error);
        }
    });

    // 健康检查端点
    router.get('/api/health', (req, res) => {
        res.json({
            success: true,
            status: 'healthy',
            timestamp: new Date().toISOString(),
            pid: process.pid,
            nodeVersion: process.version,
            gcEnabled: typeof global.gc === 'function'
        });
    });

    // 获取进程信息端点（调试）
    router.get('/api/process-info', (req, res) => {
        // 获取关键变量调试
        const keyEnvVars = {};
        const keysToCheck = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NODE_ENV', 'PORT'];

        keysToCheck.forEach(key => {
            if (process.env[key]) {
                keyEnvVars[key] = process.env[key];
            }
        });

        res.json({
            success: true,
            data: {
                pid: process.pid,
                platform: process.platform,
                version: process.version,
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                cwd: process.cwd(),
                execPath: process.execPath,
                execArgv: process.execArgv,
                argv: process.argv,
                gcEnabled: typeof global.gc === 'function',
                keyEnvVars: keyEnvVars
            }
        });
    });
}