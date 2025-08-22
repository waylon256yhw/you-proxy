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

    generateTimestampedFilename() {
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

        return `${this.filePrefix}${timestamp}${this.fileExtension}`;
    }

    /**
     * 创建时间排序
     */
    getDebugFiles() {
        try {
            return fs.readdirSync(this.debugDir)
                .filter(file => file.startsWith(this.filePrefix) && file.endsWith(this.fileExtension))
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
    cleanupOldFiles() {
        const files = this.getDebugFiles();

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
     * 保存
     */
    saveDebugMessage(content) {
        try {
            // 清理旧文件
            this.cleanupOldFiles();

            const filename = this.generateTimestampedFilename();
            const filePath = path.join(this.debugDir, filename);

            const timestamp = new Date().toISOString();
            const enhancedContent = `====== 调试消息副本 ======\n` +
                                  `生成时间: ${timestamp}\n` +
                                  `文件名: ${filename}\n` +
                                  `========================` +
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
     * 获取统计信息
     */
    getStats() {
        const files = this.getDebugFiles();
        const totalSize = files.reduce((sum, file) => {
            try {
                const stats = fs.statSync(file.path);
                return sum + stats.size;
            } catch {
                return sum;
            }
        }, 0);

        return {
            fileCount: files.length,
            totalSize: totalSize,
            totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
            oldestFile: files[0]?.name || null,
            newestFile: files[files.length - 1]?.name || null
        };
    }
}

export default DebugMessageManager;