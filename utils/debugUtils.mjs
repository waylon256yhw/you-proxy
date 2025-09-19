import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 调试打印请求详情
 * @param {object} req - Express请求
 * @param {object} jsonBody - 解析后请求体
 * @param {string} apiType - API类型 ('openai' 或 'anthropic')
 */
export function debugPrintRequest(req, jsonBody, apiType = 'openai') {
    if (process.env.DEBUG_REQUESTS !== 'true') {
        return;
    }

    const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const timestamp = new Date().toISOString();
    const fullDebugData = {
        timestamp: timestamp,
        clientIp: clientIp,
        apiType: apiType.toUpperCase(),
        requestPath: req.path,
        requestMethod: req.method,
        headers: req.headers,
        rawBodyLength: req.rawBody.length,
        rawBodySize: Buffer.byteLength(req.rawBody, 'utf8'),
        rawBody: req.rawBody,
        parsedBody: jsonBody,
        messages: jsonBody?.messages || [],
        parameters: extractParameters(jsonBody, apiType)
    };

    console.log("\n========== Request Debug Start ==========");
    console.log(`【时间戳】${timestamp}`);
    console.log(`【客户端IP】${clientIp}`);
    console.log(`【API类型】${apiType.toUpperCase()}`);
    console.log(`【请求路径】${req.path}`);
    console.log(`【请求方法】${req.method}`);

    console.log("\n【请求头】");
    const sanitizedHeaders = {...req.headers};
    if (sanitizedHeaders.authorization) {
        sanitizedHeaders.authorization = sanitizedHeaders.authorization.substring(0, 20) + '...';
    }
    if (sanitizedHeaders['x-api-key']) {
        sanitizedHeaders['x-api-key'] = sanitizedHeaders['x-api-key'].substring(0, 10) + '...';
    }
    console.log(JSON.stringify(sanitizedHeaders, null, 2));

    console.log("\n【原始请求体信息】");
    console.log(`- 长度: ${req.rawBody.length} 字符`);
    console.log(`- 大小: ${Buffer.byteLength(req.rawBody, 'utf8')} 字节`);

    if (process.env.DEBUG_VERBOSE === 'true') {
        console.log("- 内容:");
        console.log(req.rawBody);
    } else if (req.rawBody.length > 500) {
        console.log(`- 内容预览: ${req.rawBody.substring(0, 500)}...`);
    } else {
        console.log(`- 内容: ${req.rawBody}`);
    }

    console.log("\n【解析后的请求体结构】");
    const bodyKeys = Object.keys(jsonBody || {});
    console.log(`- 字段数量: ${bodyKeys.length}`);
    console.log(`- 字段列表: ${bodyKeys.join(', ')}`);

    // 消息详情
    if (jsonBody?.messages) {
        console.log("\n【消息详情】");
        console.log(`- 消息数量: ${jsonBody.messages.length}`);
        console.log("- 消息内容:");

        const displayMessages = jsonBody.messages.map((msg, index) => {
            const displayMsg = {
                index: index,
                role: msg.role
            };

            // 处理内容
            if (typeof msg.content === 'string') {
                const maxLength = process.env.DEBUG_VERBOSE === 'true' ? msg.content.length : 500;
                displayMsg.content = msg.content.length > maxLength
                    ? msg.content.substring(0, maxLength) + '...[截断]'
                    : msg.content;
                displayMsg.contentLength = msg.content.length;
            } else if (Array.isArray(msg.content)) {
                displayMsg.contentType = 'array';
                displayMsg.contentItems = msg.content.map(item => {
                    const itemSummary = {type: item.type};
                    if (item.type === 'text') {
                        const maxLength = process.env.DEBUG_VERBOSE === 'true' ? item.text.length : 200;
                        itemSummary.text = item.text?.length > maxLength
                            ? item.text.substring(0, maxLength) + '...[截断]'
                            : item.text;
                        itemSummary.textLength = item.text?.length;
                    } else if (item.type === 'image' || item.type === 'image_url') {
                        itemSummary.imageInfo = {
                            hasUrl: !!item.image_url?.url,
                            hasBase64: !!item.source?.data,
                            mediaType: item.source?.media_type || item.image_url?.detail || 'unknown'
                        };
                    }
                    return itemSummary;
                });
            } else {
                displayMsg.content = msg.content;
                displayMsg.contentType = typeof msg.content;
            }

            // 添加其他字段
            const otherFields = Object.keys(msg).filter(key => !['role', 'content'].includes(key));
            if (otherFields.length > 0) {
                displayMsg.otherFields = {};
                otherFields.forEach(field => {
                    displayMsg.otherFields[field] = msg[field];
                });
            }

            return displayMsg;
        });
        console.log(JSON.stringify(displayMessages, null, 2));
    }

    // API特定参数
    console.log("\n【请求参数】");
    const parameters = extractParameters(jsonBody, apiType);
    Object.entries(parameters).forEach(([key, value]) => {
        console.log(`- ${key}: ${value}`);
    });

    // 其他未列出的参数
    const knownParams = getKnownParams(apiType);
    const unknownParams = Object.keys(jsonBody || {}).filter(key => !knownParams.includes(key));
    if (unknownParams.length > 0) {
        console.log(`\n【其他参数】`);
        unknownParams.forEach(param => {
            const value = jsonBody[param];
            const displayValue = typeof value === 'object' ? JSON.stringify(value).substring(0, 100) : value;
            console.log(`- ${param}: ${displayValue}`);
        });
    }

    console.log("========== Request Debug End ==========\n");
    
    try {
        // 保存到项目根目录（向上一级）
        const filename = `debug_request_${apiType}.json`;
        const filepath = path.join(__dirname, '..', filename);
        fs.writeFileSync(filepath, JSON.stringify(fullDebugData, null, 2), 'utf8');
        console.log(`【调试日志已保存】${filepath}`);
    } catch (error) {
        console.error('保存调试日志失败:', error);
    }
}

/**
 * 提取参数
 * @param {object} jsonBody - 请求体
 * @param {string} apiType - API类型
 * @returns {object} 参数对象
 */
export function extractParameters(jsonBody, apiType) {
    const params = {};

    if (apiType === 'openai') {
        params.model = jsonBody?.model || '未指定';
        params.stream = jsonBody?.stream || false;
        params.temperature = jsonBody?.temperature ?? '默认';
        params.max_tokens = jsonBody?.max_tokens || '未限制';
        params.top_p = jsonBody?.top_p ?? '默认';
        params.frequency_penalty = jsonBody?.frequency_penalty ?? 0;
        params.presence_penalty = jsonBody?.presence_penalty ?? 0;
        params.n = jsonBody?.n || 1;
        params.stop = Array.isArray(jsonBody?.stop) ? jsonBody.stop.join(', ') : jsonBody?.stop || '无';
        params.seed = jsonBody?.seed || '未设置';
        params.tools = jsonBody?.tools ? `${jsonBody.tools.length} 个工具` : '无';
        params.tool_choice = jsonBody?.tool_choice || '无';
        params.response_format = jsonBody?.response_format?.type || '默认';
        params.logprobs = jsonBody?.logprobs || false;
        params.top_logprobs = jsonBody?.top_logprobs || '无';
        params.user = jsonBody?.user || '未指定';
    } else if (apiType === 'anthropic') {
        params.model = jsonBody?.model || '未指定';
        params.stream = jsonBody?.stream || false;
        params.max_tokens = jsonBody?.max_tokens || '默认';
        params.temperature = jsonBody?.temperature ?? '默认';
        params.top_p = jsonBody?.top_p ?? '默认';
        params.top_k = jsonBody?.top_k || '默认';
        params.stop_sequences = Array.isArray(jsonBody?.stop_sequences) ? jsonBody.stop_sequences.join(', ') : '无';
        let systemInfo = '无';
        if (jsonBody?.system) {
            const lengthInfo = typeof jsonBody.system === 'string'
                ? jsonBody.system.length
                : 'array';
            systemInfo = `已设置 (${lengthInfo} 字符)`;
        }
        params.system = systemInfo;
        params.metadata = jsonBody?.metadata ? JSON.stringify(jsonBody.metadata) : '无';
    }
    return params;
}

/**
 * 获取已知参数列表
 * @param {string} apiType - API类型
 * @returns {array} 参数列表
 */
export function getKnownParams(apiType) {
    const commonParams = ['model', 'messages', 'stream', 'temperature', 'max_tokens', 'top_p'];

    if (apiType === 'openai') {
        return [...commonParams, 'frequency_penalty', 'presence_penalty', 'n', 'stop', 'seed',
                'tools', 'tool_choice', 'response_format', 'logprobs', 'top_logprobs', 'user'];
    } else {
        return [...commonParams, 'top_k', 'stop_sequences', 'system', 'metadata'];
    }
}