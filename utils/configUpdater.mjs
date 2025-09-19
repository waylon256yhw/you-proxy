import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 配置文件更新器
 * 负责提取用户名写回config.mjs
 */
export class ConfigUpdater {
    constructor(configPath) {
        this.configPath = configPath || path.join(process.cwd(), 'config.mjs');
        this.backupPath = this.configPath + '.backup';
    }

    /**
     * 读取并解析
     */
    async readConfig() {
        try {
            const content = await fs.readFile(this.configPath, 'utf8');
            // 动态导入
            const timestamp = Date.now();
            const tempPath = `${this.configPath}?t=${timestamp}`;

            return this.parseConfigText(content);
        } catch (error) {
            console.error('读取配置文件失败:', error);
            throw error;
        }
    }

    /**
     * 解析配置文件文本
     */
    parseConfigText(content) {
        // 提取export const config = {...}结构
        const configMatch = content.match(/export\s+const\s+config\s*=\s*(\{[\s\S]*\});?\s*$/);
        if (!configMatch) {
            throw new Error('无法解析config.mjs文件格式');
        }

        try {
            // Function安全评估
            const configObj = new Function(`return ${configMatch[1]}`)();
            return {
                fullContent: content,
                configObject: configObj,
                configMatch: configMatch
            };
        } catch (error) {
            throw new Error(`解析配置对象失败: ${error.message}`);
        }
    }

    /**
     * 更新sessions中用户名
     * @param {Object} sessionsWithUsernames - 包含索引和用户名映射
     */
    async updateSessionUsernames(sessionsWithUsernames) {
        try {
            // 创建备份
            await this.createBackup();

            // 读取
            const { fullContent, configObject } = await this.readConfig();

            // 验证sessions
            if (!configObject.sessions || !Array.isArray(configObject.sessions)) {
                throw new Error('配置文件中没找到sessions数组');
            }

            // 更新sessions
            let updated = false;
            for (const [index, username] of Object.entries(sessionsWithUsernames)) {
                const sessionIndex = parseInt(index);
                if (configObject.sessions[sessionIndex]) {
                    // 添加或更新username
                    if (configObject.sessions[sessionIndex].username !== username) {
                        configObject.sessions[sessionIndex].username = username;
                        updated = true;
                        console.log(`更新session #${sessionIndex}: 添加username="${username}"`);
                    }
                }
            }

            if (!updated) {
                return false;
            }

            // 生成新配置文本
            const newContent = this.generateConfigText(configObject);

            // 写入
            await fs.writeFile(this.configPath, newContent, 'utf8');
            console.log('✅ config.mjs更新');

            return true;

        } catch (error) {
            console.error('更新配置文件失败:', error);
            // 尝试恢复
            await this.restoreBackup();
            throw error;
        }
    }

    /**
     * 生成格式化配置
     */
    generateConfigText(configObject) {
        // 手动格式化
        let content = 'export const config = {\n';

        // 处理sessions数组
        if (configObject.sessions) {
            content += '    "sessions": [\n';

            configObject.sessions.forEach((session, index) => {
                content += '        {\n';

                // cookie字段
                if (session.cookie !== undefined) {
                    content += `            "cookie": "${session.cookie}"`;
                }

                // 添加其他字段
                const otherFields = Object.entries(session)
                    .filter(([key]) => key !== 'cookie')
                    .map(([key, value]) => {
                        const valueStr = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
                        return `            "${key}": ${valueStr}`;
                    });

                if (otherFields.length > 0) {
                    if (session.cookie !== undefined) {
                        content += ',\n';
                    }
                    content += otherFields.join(',\n');
                }

                content += '\n        }';
                if (index < configObject.sessions.length - 1) {
                    content += ',';
                }
                content += '\n';
            });

            content += '    ]';
        }

        // 处理其他顶级字段
        const otherFields = Object.entries(configObject)
            .filter(([key]) => key !== 'sessions');

        if (otherFields.length > 0) {
            content += ',\n';
            content += otherFields.map(([key, value]) => {
                const valueStr = JSON.stringify(value, null, 4).split('\n').join('\n    ');
                return `    "${key}": ${valueStr}`;
            }).join(',\n');
        }

        content += '\n};\n';

        return content;
    }

    /**
     * 创建备份
     */
    async createBackup() {
        try {
            await fs.copyFile(this.configPath, this.backupPath);
        } catch (error) {
            console.error('创建备份失败:', error);
        }
    }

    /**
     * 恢复备份
     */
    async restoreBackup() {
        try {
            await fs.copyFile(this.backupPath, this.configPath);
        } catch (error) {
            console.error('恢复备份失败:', error);
        }
    }
}