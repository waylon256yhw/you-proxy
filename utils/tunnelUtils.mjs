import localtunnel from "localtunnel";
import ngrok from 'ngrok';
import fetch from 'node-fetch';

/**
 * 创建 localtunnel 隧道
 * @param {number} port - 本地端口
 * @param {string} subdomain - 子域名
 * @returns {Promise<object>} 隧道对象
 */
export async function createLocaltunnel(port, subdomain) {
    const tunnelOptions = { port };
    if (subdomain) {
        tunnelOptions.subdomain = subdomain;
    }

    try {
        const tunnel = await localtunnel(tunnelOptions);
        console.log(`隧道已成功创建，可通过以下URL访问: ${tunnel.url}/v1`);
        tunnel.on("close", () => console.log("已关闭隧道"));
        return tunnel;
    } catch (error) {
        console.error("Failed to create localtunnel tunnel:", error);
        throw error;
    }
}

/**
 * 创建 ngrok 隧道
 * @param {number} port - 本地端口
 * @param {string} authToken - ngrok的认证token
 * @param {string} customDomain - 自定义域名
 * @param {string} subdomain - 子域名
 * @returns {Promise<object>} 隧道信息
 */
export async function createNgrok(port, authToken, customDomain, subdomain) {
    const ngrokOptions = {
        addr: port,
        authtoken: authToken,
        region: process.env.NGROK_REGION || 'us',
        web_addr: process.env.NGROK_WEB_ADDR || '127.0.0.1:4040', // ngrok管理界面
        bind_tls: process.env.NGROK_BIND_TLS || true, // 强制使用TLS
    };

    if (customDomain) {
        ngrokOptions.hostname = customDomain;
    } else if (subdomain) {
        ngrokOptions.subdomain = subdomain;
    }

    // 临时清除代理环境变量，避免ngrok连接问题
    const originalHttpProxy = process.env.HTTP_PROXY;
    const originalHttpsProxy = process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;

    try {
        const url = await ngrok.connect(ngrokOptions);
        console.log(`Ngrok隧道创建成功: ${url}/v1`);
        console.log(`管理界面: http://${ngrokOptions.web_addr}`);

        // 获取隧道详细信息
        const tunnels = await ngrok.getApi().listTunnels();
        const tunnelInfo = tunnels.tunnels.find(t => t.public_url === url);

        if (tunnelInfo) {
            console.log(`Tunnel ID: ${tunnelInfo.name}`);
            console.log(`Protocol: ${tunnelInfo.proto}`);
            console.log(`Region: ${ngrokOptions.region}`);
        }

        // 创建隧道对象
        const tunnelObject = {
            url: url,
            publicUrl: url,
            region: ngrokOptions.region,
            tunnelId: tunnelInfo?.name,
            webInterface: `http://${ngrokOptions.web_addr}`,
            startTime: new Date(),

            checkHealth: async () => {
                try {
                    const api = ngrok.getApi();
                    const tunnels = await api.listTunnels();
                    const isActive = tunnels.tunnels.some(t => t.public_url === url);

                    if (isActive) {
                        // 尝试实际访问隧道
                        const testUrl = `${url}/health`;
                        const response = await fetch(testUrl, {
                            method: 'GET',
                            timeout: 5000,
                            headers: {
                                'User-Agent': 'Ngrok-Health-Check'
                            }
                        }).catch(() => null);

                        return {
                            status: 'active',
                            accessible: response !== null,
                            uptime: Date.now() - tunnelObject.startTime.getTime()
                        };
                    }

                    return { status: 'inactive', accessible: false };
                } catch (error) {
                    return { status: 'error', error: error.message };
                }
            },

            restart: async () => {
                console.log('重启ngrok隧道...');
                try {
                    await ngrok.disconnect(url);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    const newUrl = await ngrok.connect(ngrokOptions);
                    tunnelObject.url = newUrl;
                    tunnelObject.publicUrl = newUrl;
                    tunnelObject.startTime = new Date();
                    console.log(`隧道重启成功: ${newUrl}/v1`);
                    return newUrl;
                } catch (error) {
                    console.error('tunnel Restart Failed:', error);
                    throw error;
                }
            },

            close: async () => {
                await ngrok.disconnect(url);
                console.log("已关闭ngrok隧道");
            }
        };

        // 健康监控
        if (process.env.NGROK_HEALTH_CHECK === 'true') {
            startHealthMonitoring(tunnelObject);
        }
        process.on('SIGTERM', async () => {
            await tunnelObject.close();
        });

        process.on('SIGINT', async () => {
            await tunnelObject.close();
            process.exit(0);
        });
        
        return tunnelObject;

    } catch (error) {
        console.error("Failed to create ngrok tunnel:", error);
        if (error.message.includes('authentication')) {
            console.error('Authentication failed, please check NGROK_AUTH_TOKEN');
        } else if (error.message.includes('connect')) {
            console.error('Connection failed, please check your network and firewall settings');
        } else if (error.message.includes('subdomain')) {
            console.error('Subdomain is already in use or you do not have permission to use it');
        }

        throw error;
    } finally {
        // 恢复代理设置
        if (originalHttpProxy) process.env.HTTP_PROXY = originalHttpProxy;
        if (originalHttpsProxy) process.env.HTTPS_PROXY = originalHttpsProxy;
    }
}

/**
 * 健康监控
 * @param {object} tunnelObject
 */
function startHealthMonitoring(tunnelObject) {
    const checkInterval = parseInt(process.env.NGROK_HEALTH_INTERVAL) || 60000; // 默认60秒
    const maxRetries = parseInt(process.env.NGROK_MAX_RETRIES) || 3;
    let failureCount = 0;

    const monitor = setInterval(async () => {
        const health = await tunnelObject.checkHealth();

        if (health.status === 'active' && health.accessible) {
            if (failureCount > 0) {
                console.log(`Ngrok隧道恢复正常 (${tunnelObject.url})/v1`);
                failureCount = 0;
            }
        } else {
            failureCount++;
            console.warn(`Ngrok tunnel health check failed (${failureCount}/${maxRetries}): ${JSON.stringify(health)}`);

            if (failureCount >= maxRetries) {
                console.error(`Ngrok tunnel failed too many times, attempting to restart...`);
                try {
                    await tunnelObject.restart();
                    failureCount = 0;
                } catch (error) {
                    console.error('Tunnel restart failed, stopping monitoring:', error);
                    clearInterval(monitor);
                }
            }
        }
    }, checkInterval);

    // 保存监控器
    tunnelObject.healthMonitor = monitor;

    // 清理
    const originalClose = tunnelObject.close;
    tunnelObject.close = async () => {
        clearInterval(monitor);
        await originalClose();
    };

    console.log(`Ngrok health monitoring started, check interval: ${checkInterval}ms`);
}

/**
 * 创建隧道（统一接口）
 * @param {string} tunnelType - 隧道类型 ('localtunnel' 或 'ngrok')
 * @param {number} port - 本地端口
 * @param {object} options - 配置选项
 * @returns {Promise<any>} 隧道对象或URL
 */
export async function createTunnel(tunnelType, port, options = {}) {
    console.log(`创建 ${tunnelType} 隧道中...`);
    
    if (tunnelType === "localtunnel") {
        return createLocaltunnel(port, options.subdomain || process.env.SUBDOMAIN);
    } else if (tunnelType === "ngrok") {
        return createNgrok(
            port, 
            options.authToken || process.env.NGROK_AUTH_TOKEN,
            options.customDomain || process.env.NGROK_CUSTOM_DOMAIN,
            options.subdomain || process.env.NGROK_SUBDOMAIN
        );
    } else {
        throw new Error(`Unsupported tunnel type: ${tunnelType}`);
    }
}

/**
 * 根据环境变量自动创建隧道
 * @param {number} port - 本地端口
 * @returns {Promise<any>} 隧道对象或URL，如果未启用返回null
 */
export async function setupTunnelFromEnv(port) {
    if (process.env.ENABLE_TUNNEL !== "true") {
        return null;
    }

    const tunnelType = process.env.TUNNEL_TYPE || "localtunnel";
    
    try {
        const tunnel = await createTunnel(tunnelType, port);

        // if (tunnelType === "ngrok" && tunnel.url) {
        //     console.log('\n=== Ngrok Connection Optimization Suggestions ===');
        //     console.log(`   - Use the URL directly: ${tunnel.url}/v1`);
        //     console.log(`   - Backup URL: ${tunnel.url.replace('https://', 'http://')}/v1`);
        //     console.log('2. If the connection is unstable, you can try:');
        //     console.log('   - Set NGROK_REGION=us (US region)');
        //     console.log('   - Set NGROK_REGION=eu (Europe region)');
        //     console.log('   - Set NGROK_REGION=ap (Asia-Pacific region)');
        //     console.log('3. Enable health check: NGROK_HEALTH_CHECK=true');
        //     console.log('4. Check the management interface for more information: ' + (tunnel.webInterface || 'http://127.0.0.1:4040'));
        //     console.log('========================\n');
        // }

        return tunnel;
    } catch (error) {
        console.error(`Tunnel setup failed: ${error.message}`);
        return null;
    }
}