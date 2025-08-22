import {fetchWithRetry} from './utils/httpClient.mjs';
import {SocksProxyAgent} from 'socks-proxy-agent';
import HttpsProxyAgent from 'https-proxy-agent';
import {createRequestTLSOptions} from './utils/tlsConfig.mjs';
import fs from 'fs/promises';
import path from 'path';

class ModelManager {
    constructor() {
        this.defaultModels = [
            "openai_o3_mini_high",
            "openai_o3_mini_medium",
            "openai_o1",
            "openai_o1_preview",
            "gpt_4_5_preview",
            "gpt_4o",
            "gpt_4_turbo",
            "gpt_4",
            "claude_3_7_sonnet",
            "claude_3_7_sonnet_thinking",
            "claude_3_5_sonnet",
            "claude_3_opus",
            "claude_3_sonnet",
            "claude_3_haiku",
            "claude_2",
            "llama3",
            "gemini_pro",
            "gemini_1_5_pro",
            "gemini_1_5_flash",
            "databricks_dbrx_instruct",
            "command_r",
            "command_r_plus",
            "zephyr",
            "qwen2p5_72b",
            "llama3_1_405b",
            "grok_2",
            "deepseek_r1",
            "deepseek_v3"
        ];

        this.availableModels = [...this.defaultModels]; // 当前使用模型列表
        this.lastRefreshTime = 0; // 最近刷新
        this.defaultBuildHash = "812b7f218a5e148fdc739ca2c4bdd644742fa03d"; // 默认哈希值
        this.requestTimeouts = {
            connectTimeout: 8000,  // 连接超时(ms)
            requestTimeout: 12000  // 请求总超时(ms)
        };
        this.lastError = null; // 错误信息

        this.cacheFilePath = path.join(process.cwd(), 'models-cache.json');

        // 检查 Cloudflare Worker API 替代
        this.useCloudflareWorker = process.env.USE_CLOUDFLARE_WORKER === 'true';
        this.cloudflareWorkerUrl = process.env.CLOUDFLARE_WORKER_URL || 'https://you-models.youproxy.workers.dev';

        this.regionDetected = false;
        this.isChinaRegion = false; // CN地区
        this.detectRegion(); // 初始化检测
        this.initialize();
    }

    /**
     * 初始化 - 从缓存加载模型
     */
    async initialize() {
        try {
            const cachedModels = await this.loadModelsFromCache();
            if (cachedModels && Array.isArray(cachedModels) && cachedModels.length > 0) {
                this.availableModels = [...cachedModels];
            }
        } catch (error) {
            console.error('Failed to initialize cache loading:', error);
        }
    }

    /**
     * 检测地区
     */
    detectRegion() {
        if (this.regionDetected) {
            return;
        }

        try {
            const envRegion = (process.env.REGION || '').toUpperCase();
            if (envRegion === 'CN' || envRegion === 'CHINA') {
                this.isChinaRegion = true;
                this.regionDetected = true;
                return;
            }

            const locale = process.env.LANG || process.env.LANGUAGE || process.env.LC_ALL || '';
            if (locale.includes('zh_CN')) {
                this.isChinaRegion = true;
                this.regionDetected = true;
                return;
            }
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (timezone === 'Asia/Shanghai' || timezone === 'Asia/Chongqing' ||
                timezone === 'Asia/Harbin' || timezone === 'Asia/Urumqi' ||
                timezone === 'Asia/Hong_Kong') {
                this.isChinaRegion = true;
                this.regionDetected = true;
                return;
            }
            this.regionDetected = true;
        } catch (error) {
            console.error(`Error detecting region: ${error.message}`);
            this.regionDetected = true;
            this.isChinaRegion = false;
        }
    }

    /**
     * 检查是否设置代理
     * @returns {boolean}
     */
    hasProxyConfigured() {
        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY ||
            process.env.http_proxy || process.env.HTTP_PROXY;
        return !!proxyUrl;
    }

    /**
     * @returns {boolean}
     */
    shouldSkipModelRequest() {
        if (process.env.FORCE_MODEL_FETCH === 'true') {
            return false;
        }

        if (this.useCloudflareWorker) {
            return false;
        }

        return this.isChinaRegion && !this.hasProxyConfigured();
    }

    /**
     * 获取哈希值，优先级：环境变量 > 默认值
     * @returns {string}
     */
    getBuildHash() {
        const envHash = process.env.YOU_BUILD_HASH;
        if (envHash && typeof envHash === 'string' && envHash.length >= 30) {
            return envHash;
        }
        return this.defaultBuildHash;
    }

    /**
     * 设置配置
     * @param {Object} config
     */
    setConfig(config) {
        this.config = config;
    }

    /**
     * 强制刷新
     * @param {string} newHash
     * @returns {boolean}
     */
    updateBuildHash(newHash) {
        if (!newHash || typeof newHash !== 'string' || newHash.length < 32) {
            console.warn('Invalid build hash, not updated');
            return false;
        }

        if (this.config) {
            this.config.buildHash = newHash;
        }
        return true;
    }

    /**
     * 创建代理
     * @returns {SocksProxyAgent}
     */
    createProxyAgent() {
        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY ||
            process.env.http_proxy || process.env.HTTP_PROXY;

        if (!proxyUrl) return null;

        try {
            // 获取TLS
            const tlsOptions = createRequestTLSOptions();

            if (proxyUrl.startsWith('socks5://')) {
                return new SocksProxyAgent(proxyUrl, {
                    tls: {
                        ...tlsOptions,
                        rejectUnauthorized: true
                    },
                    timeout: this.requestTimeouts.connectTimeout
                });
            } else {
                return new HttpsProxyAgent.HttpsProxyAgent(proxyUrl, {
                    ...tlsOptions,
                    rejectUnauthorized: true,
                    timeout: this.requestTimeouts.connectTimeout
                });
            }
        } catch (error) {
            console.error(`Proxy configuration error: ${error.message}`);
            return null;
        }
    }

    /**
     * 保存到本地
     * @param {string[]} models
     * @returns {Promise<boolean>}
     */
    async saveModelsToCache(models) {
        try {
            if (!Array.isArray(models) || models.length === 0) {
                console.warn('No valid models to save to cache');
                return false;
            }

            const timestamp = Date.now();
            // 时间戳
            const formattedTimestamp = new Date(timestamp).toLocaleString();

            const cacheData = {
                models: models,
                timestamp: timestamp,
                formattedTimestamp: formattedTimestamp,
                cacheAge: {
                    hours: 0,
                    formatted: '刚刚更新'
                },
                hash: this.getBuildHash()
            };

            await fs.writeFile(
                this.cacheFilePath,
                JSON.stringify(cacheData, null, 2),
                'utf8'
            );

            console.log(`✅ Cache updated: Saved ${models.length} models`);
            return true;
        } catch (error) {
            console.error(`Error saving models to cache: ${error.message}`);
            return false;
        }
    }

    /**
     * 从本地加载
     * @returns {Promise<string[]|null>}
     */
    async loadModelsFromCache() {
        try {
            const fileContent = await fs.readFile(this.cacheFilePath, 'utf8');
            const cacheData = JSON.parse(fileContent);

            if (!cacheData || !Array.isArray(cacheData.models) || cacheData.models.length === 0) {
                console.warn('Invalid cache data format');
                return null;
            }

            const cacheAge = Date.now() - (cacheData.timestamp || 0);
            const cacheAgeHours = Math.round(cacheAge / (1000 * 60 * 60));

            if (!cacheData.cacheAge) {
                cacheData.cacheAge = {};
            }
            cacheData.cacheAge.hours = cacheAgeHours;
            cacheData.cacheAge.formatted = cacheAgeHours <= 0 ?
                '刚刚更新' : `${cacheAgeHours}小时前`;

            const displayTime = cacheData.formattedTimestamp ||
                (cacheData.timestamp ? new Date(cacheData.timestamp).toLocaleString() : '未知时间');

            console.log(`从缓存加载 ${cacheData.models.length} 个模型（缓存时间: ${displayTime}，${cacheData.cacheAge.formatted}）`);
            return cacheData.models;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`Error loading models from cache: ${error.message}`);
            }
            return null;
        }
    }

    /**
     * Cloudflare Worker API 获取模型列表
     * @returns {Promise<string[]>}
     */
    async fetchModelsFromWorkerApi() {
        try {
            const response = await fetchWithRetry(this.cloudflareWorkerUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                },
                timeout: this.requestTimeouts.requestTimeout
            });

            if (!response.ok) {
                console.warn(`Worker API request failed, HTTP status: ${response.status}`);
                return null;
            }

            const data = await response.json();

            if (!data || !Array.isArray(data.models) || data.models.length === 0) {
                console.warn('Worker API 响应中没有找到模型数据');
                return null;
            }

            console.log(`从 Worker API 成功获取 ${data.models.length} 个模型 ID`);
            return data.models;

        } catch (error) {
            console.error(`Error fetching from Worker API: ${error.message}`);
            return null;
        }
    }

    /**
     * 获取模型列表
     * @returns {Promise<string[]>}
     */
    async fetchModelsFromApi() {
        if (this.shouldSkipModelRequest()) {
            console.log('当前CN环境, 使用默认(缓存文件)模型列表. 可尝试设置"http_proxy"自动获取模型列表');

            // 从缓存加载
            const cachedModels = await this.loadModelsFromCache();
            if (cachedModels && cachedModels.length > 0) {
                this.availableModels = [...cachedModels];
                return cachedModels;
            }

            return this.defaultModels;
        }
        if (this.useCloudflareWorker) {
            const workerModels = await this.fetchModelsFromWorkerApi();
            if (workerModels && workerModels.length > 0) {
                this.availableModels = [...workerModels];
                return workerModels;
            }
            console.log('Worker API fetch failed, attempting to use cache');
            const cachedModels = await this.loadModelsFromCache();
            if (cachedModels && cachedModels.length > 0) {
                this.availableModels = [...cachedModels];
                return cachedModels;
            }
        }

        // 标准 API 获取
        const buildHash = this.getBuildHash();
        const apiUrl = `https://you.com/_next/data/${buildHash}/en-US/search.json`;

        try {
            const proxyAgent = this.createProxyAgent();
            const requestOptions = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache'
                },
                timeout: this.requestTimeouts.requestTimeout
            };
            if (proxyAgent) {
                requestOptions.agent = proxyAgent;
            }

            const response = await fetchWithRetry(apiUrl, requestOptions, 0); // 无重试

            if (!response.ok) {
                const errorMessage = `API request failed, HTTP status: ${response.status}`;
                console.error(errorMessage);
                this.lastError = errorMessage;

                const cachedModels = await this.loadModelsFromCache();
                if (cachedModels && cachedModels.length > 0) {
                    this.availableModels = [...cachedModels];
                    return cachedModels;
                }

                return this.defaultModels;
            }

            const data = await response.json();

            if (!data || !data.pageProps || !data.pageProps.aiModels || !Array.isArray(data.pageProps.aiModels)) {
                const errorMessage = 'API 响应中没有找到模型数据';
                console.error(errorMessage);
                this.lastError = errorMessage;

                const cachedModels = await this.loadModelsFromCache();
                if (cachedModels && cachedModels.length > 0) {
                    this.availableModels = [...cachedModels];
                    return cachedModels;
                }

                return this.defaultModels;
            }

            const modelIds = data.pageProps.aiModels
                .map(model => model.id)
                .filter(id => id && typeof id === 'string');

            if (modelIds.length === 0) {
                const errorMessage = '没有找到有效的模型 ID';
                console.error(errorMessage);
                this.lastError = errorMessage;

                const cachedModels = await this.loadModelsFromCache();
                if (cachedModels && cachedModels.length > 0) {
                    this.availableModels = [...cachedModels];
                    return cachedModels;
                }

                return this.defaultModels;
            }

            this.availableModels = [...modelIds];
            this.lastError = null;
            console.log(`成功获取 ${modelIds.length} 个模型 ID`);
            return modelIds;

        } catch (error) {
            const errorMessage = `获取模型列表时出错: ${error.message}`;
            console.error(errorMessage);
            this.lastError = errorMessage;
            const cachedModels = await this.loadModelsFromCache();
            if (cachedModels && cachedModels.length > 0) {
                this.availableModels = [...cachedModels];
                return cachedModels;
            }

            return this.defaultModels;
        }
    }

    /**
     * 判断列表是否相同
     * @param {string[]} listA
     * @param {string[]} listB
     * @returns {boolean}
     */
    areModelListsEqual(listA, listB) {
        if (!Array.isArray(listA) || !Array.isArray(listB) || listA.length !== listB.length) {
            return false;
        }

        const sortedA = [...listA].sort();
        const sortedB = [...listB].sort();

        return JSON.stringify(sortedA) === JSON.stringify(sortedB);
    }

    /**
     * 刷新模型列表
     * @returns {Promise<boolean>}
     */
    async refreshModels() {
        try {
            // 加载当前缓存作为比较基准
            const cachedModels = await this.loadModelsFromCache();

            // 获取新模型列表
            const newModels = await this.fetchModelsFromApi();

            if (!newModels || newModels.length === 0) {
                return false;
            }

            // 更新内存中模型列表
            this.availableModels = [...newModels];

            // 比较
            const referenceModels = cachedModels && cachedModels.length > 0
                ? cachedModels
                : this.defaultModels;

            if (!this.areModelListsEqual(newModels, referenceModels)) {
                console.log('🔄 Model list changed, updating cache...');

                const added = newModels.filter(m => !referenceModels.includes(m));
                const removed = referenceModels.filter(m => !newModels.includes(m));

                if (added.length > 0) {
                    console.log(`➕ Added models: ${added.join(', ')}`);
                }
                if (removed.length > 0) {
                    console.log(`➖ Removed models: ${removed.join(', ')}`);
                }

                // 保存
                await this.saveModelsToCache(newModels);
            } else {
                console.log('✅ Model list has not changed');
            }

            this.lastRefreshTime = Date.now();
            return true;
        } catch (error) {
            const errorMessage = `Error refreshing model list: ${error.message}`;
            console.error(errorMessage);
            this.lastError = errorMessage;
            return false;
        }
    }

    /**
     * 启动自动刷新
     * @param {number} interval
     */
    startAutoRefresh(interval = 60 * 60 * 1000) { // 1小时
        this.refreshModels();
        setInterval(() => {
            this.refreshModels();
        }, interval);
    }

    /**
     * 获取可用模型列表
     * @returns {string[]}
     */
    getAvailableModels() {
        return this.availableModels;
    }

    /**
     * 检查指定模型是否可用
     * @param {string} modelId
     * @returns {boolean}
     */
    isModelAvailable(modelId) {
        return this.availableModels.includes(modelId);
    }

    /**
     * 获取最后刷新时间
     * @returns {string}
     */
    getLastRefreshTime() {
        if (this.lastRefreshTime === 0) {
            return "Not refreshed";
        }
        return new Date(this.lastRefreshTime).toLocaleString();
    }

    /**
     * 获取缓存状态
     * @returns {Promise<Object>}
     */
    async getCacheStatus() {
        try {
            const stats = await fs.stat(this.cacheFilePath).catch(() => null);

            if (!stats) {
                return {
                    exists: false,
                    size: 0,
                    modifiedTime: 'N/A',
                    formattedTimestamp: 'N/A',
                    age: 'N/A'
                };
            }

            const fileContent = await fs.readFile(this.cacheFilePath, 'utf8');
            const cacheData = JSON.parse(fileContent);
            const modelsCount = cacheData && cacheData.models ? cacheData.models.length : 0;

            const cacheAge = Date.now() - (cacheData.timestamp || 0);
            const cacheAgeHours = Math.round(cacheAge / (1000 * 60 * 60));

            return {
                exists: true,
                size: stats.size,
                modelsCount: modelsCount,
                modifiedTime: stats.mtime.toLocaleString(),
                formattedTimestamp: cacheData.formattedTimestamp ||
                    (cacheData.timestamp ? new Date(cacheData.timestamp).toLocaleString() : 'Unknown'),
                age: cacheData.cacheAge ?
                    cacheData.cacheAge.formatted :
                    (cacheData.timestamp ? `${cacheAgeHours} hours` : 'Unknown')
            };
        } catch (error) {
            return {
                exists: false,
                error: error.message
            };
        }
    }

    /**
     * 获取状态信息
     * @returns {Promise<Object>}
     */
    async getStatus() {
        const cacheStatus = await this.getCacheStatus();

        return {
            modelsCount: this.availableModels.length,
            lastRefresh: this.getLastRefreshTime(),
            lastError: this.lastError,
            useWorkerApi: this.useCloudflareWorker,
            buildHash: this.getBuildHash(),
            region: this.isChinaRegion ? 'CN' : 'non-CN',
            proxyConfigured: this.hasProxyConfigured(),
            cache: cacheStatus
        };
    }
}

const modelManager = new ModelManager();
export default modelManager;
