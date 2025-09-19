import fs from 'fs';
import path from 'path';

/**
 * 调试消息文件管理器
 */
class DebugMessageManager {
    constructor(baseDir, maxFiles = 100) {
        this.debugDir = path.join(baseDir, 'debug_messages');
        this.maxFiles = maxFiles;
        this.filePrefix = 'formatted_messages_';
        this.fileExtension = '.txt';
        this.ensureDirectoryExists();
    }

    ensureDirectoryExists() {
        try {
            if (!fs.existsSync(this.debugDir)) {
                fs.mkdirSync(this.debugDir, { recursive: true });
            }
        } catch (error) {
            console.error(`Failed to create debug directory: ${error.message}`);
            throw error;
        }
    }

    generateTimestampedFilename(prefix = null) {
        const now = new Date();

        // YYYYMMDD_HHmmss_SSS
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const milliseconds = String(now.getMilliseconds()).padStart(3, '0');

        const timestamp = `${year}${month}${day}_${hours}${minutes}${seconds}_${milliseconds}`;
        const filePrefix = prefix || this.filePrefix;

        return `${filePrefix}${timestamp}${this.fileExtension}`;
    }

    /**
     * 创建时间排序
     */
    getDebugFiles(prefix = null) {
        try {
            const searchPrefix = prefix || this.filePrefix;
            return fs.readdirSync(this.debugDir)
                .filter(file => file.startsWith(searchPrefix) && file.endsWith(this.fileExtension))
                .map(file => {
                    const filePath = path.join(this.debugDir, file);
                    const stats = fs.statSync(filePath);
                    return {
                        name: file,
                        path: filePath,
                        birthtime: stats.birthtime.getTime()
                    };
                })
                .sort((a, b) => a.birthtime - b.birthtime);
        } catch (error) {
            console.error(`Failed to read debug file list: ${error.message}`);
            return [];
        }
    }

    /**
     * 清理
     */
    cleanupOldFiles(prefix = null) {
        const files = this.getDebugFiles(prefix);

        if (files.length >= this.maxFiles) {
            const filesToDelete = files.length - this.maxFiles + 1;

            for (let i = 0; i < filesToDelete; i++) {
                try {
                    fs.unlinkSync(files[i].path);
                    console.log(`Deleting old debug file: ${files[i].name}`);
                } catch (error) {
                    console.error(`Failed to delete file ${files[i].name}: ${error.message}`);
                }
            }
        }
    }

    /**
     * 用户名打码
     */
    maskUsername(username) {
        if (!username || typeof username !== 'string') {
            return 'N/A';
        }

        const len = username.length;

        // 邮箱地址处理
        if (username.includes('@')) {
            const [localPart, domain] = username.split('@');
            const maskedLocal = this.maskString(localPart);
            return `${maskedLocal}@${domain}`;
        }

        // 用户名处理
        return this.maskString(username);
    }

    maskString(str) {
        const len = str.length;

        if (len <= 2) {
            return str[0] + '*'.repeat(len - 1);
        } else if (len <= 4) {
            return str[0] + '*'.repeat(len - 2) + str[len - 1];
        } else if (len <= 8) {
            // 长度5-8，显示前2个和后2个字符
            return str.substring(0, 2) + '*'.repeat(len - 4) + str.substring(len - 2);
        } else {
            // 长度大于8显示前4个和后4个字符
            return str.substring(0, 4) + '*'.repeat(len - 8) + str.substring(len - 4);
        }
    }

    /**
     * 保存
     */
    saveDebugMessage(content) {
        try {
            // 清理旧文件
            this.cleanupOldFiles(this.filePrefix);

            const filename = this.generateTimestampedFilename(this.filePrefix);
            const filePath = path.join(this.debugDir, filename);

            const timestamp = new Date().toISOString();
            const enhancedContent = `====== 调试消息副本 ======\n` +
                                  `生成时间: ${timestamp}\n` +
                                  `========================\n` +
                                  content;

            // 写入
            fs.writeFileSync(filePath, enhancedContent, 'utf8');

            return filePath;

        } catch (error) {
            console.error(`Failed to save debug message: ${error.message}`);
            throw error;
        }
    }

    /**
     * 追加响应数据
     */
    appendResponseData(filePath, responseEvents, metadata = {}) {
        try {
            if (!fs.existsSync(filePath)) {
                console.error(`File not found: ${filePath}`);
                return null;
            }

            // 读取现有内容
            let existingContent = fs.readFileSync(filePath, 'utf8');

            // 头部结束位置
            const headerEndIndex = existingContent.indexOf('========================');
            if (headerEndIndex === -1) {
                console.error('Invalid file format: header end marker not found');
                return null;
            }

            // 构建响应元数据
            let responseMetadata = '';
            
            responseMetadata += `用户: ${this.maskUsername(metadata.username)}\n`;
            responseMetadata += `模型: ${metadata.model || 'N/A'}\n`;
            responseMetadata += `模式: ${metadata.mode || 'N/A'}\n`;
            responseMetadata += `追踪ID: ${metadata.traceId || 'N/A'}\n`;
            if (metadata.duration) {
                const durationInSeconds = (metadata.duration / 1000).toFixed(1);
                responseMetadata += `请求耗时: ${durationInSeconds}秒\n`;
            }

            // 分割现有内容
            const beforeHeader = existingContent.substring(0, headerEndIndex);
            const afterHeaderWithSeparator = existingContent.substring(headerEndIndex);

            // 构建新头部
            const newHeader = beforeHeader + responseMetadata;

            // 组合
            let newContent = newHeader + afterHeaderWithSeparator;

            // 处理响应
            if (responseEvents && responseEvents.length > 0) {
                let responseContent = '\n\n===== API响应内容 =====\n';
                
                // 处理cot
                let thinkingContent = '';
                let responseMainContent = '';
                let isInThinking = false;
                
                responseEvents.forEach((event) => {
                    if (event.type === 'openThinking') {
                        isInThinking = true;
                        thinkingContent += '<THINKING>\n';
                    } else if (event.type === 'closeThinking') {
                        isInThinking = false;
                        thinkingContent += '\n</THINKING>\n\n';
                    } else if (event.type === 'youChatUpdate' && event.data) {
                        try {
                            const parsedData = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
                            if (parsedData.t && isInThinking) {
                                thinkingContent += parsedData.t;
                            }
                        } catch (e) {
                        }
                    } else if (event.type === 'youChatToken' && event.data) {
                        // 处理主要响应
                        try {
                            if (typeof event.data === 'object' && event.data.youChatToken) {
                                responseMainContent += event.data.youChatToken;
                            } else if (typeof event.data === 'string') {
                                const parsedData = JSON.parse(event.data);
                                if (parsedData.youChatToken) {
                                    responseMainContent += parsedData.youChatToken;
                                }
                            }
                        } catch (e) {
                            // 使用原始数据
                            responseMainContent += event.data;
                        }
                    }
                });
                
                // 组合最终响应
                if (thinkingContent.trim()) {
                    responseContent += thinkingContent;
                }
                if (responseMainContent.trim()) {
                    responseContent += responseMainContent;
                }
                
                // 添加错误信息
                const errorEvents = responseEvents.filter(e => e.type === 'error' || e.type === 'connectionError');
                if (errorEvents.length > 0) {
                    responseContent += '\n\n===== 错误信息 =====\n';
                    errorEvents.forEach(event => {
                        if (event.data) {
                            responseContent += `${event.data}\n`;
                        }
                    });
                }
                
                // 结束标记
                responseContent += '\n========================\n';
                
                // 写入新内容
                fs.writeFileSync(filePath, newContent + responseContent, 'utf8');
            } else {
                // 只更新元数据
                fs.writeFileSync(filePath, newContent, 'utf8');
            }

            return filePath;

        } catch (error) {
            console.error(`Failed to append response data: ${error.message}`);
            return null;
        }
    }

    /**
     * 获取统计信息
     */
    getStats() {
        const allFiles = this.getDebugFiles(this.filePrefix);
        const totalSize = allFiles.reduce((sum, file) => {
            try {
                const stats = fs.statSync(file.path);
                return sum + stats.size;
            } catch {
                return sum;
            }
        }, 0);

        return {
            fileCount: allFiles.length,
            totalSize: totalSize,
            totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
            oldestFile: allFiles[0]?.name || null,
            newestFile: allFiles[allFiles.length - 1]?.name || null
        };
    }
}

export default DebugMessageManager;