import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { cookieDebugger } from './debugger.mjs';
import iconv from 'iconv-lite';
import chardet from 'chardet';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

// 项目根目录
const PROJECT_ROOT = path.join(__dirname, '..');

// 保存状态管理
const saveStatus = new Map();

// 文件编码缓存
const fileEncodings = new Map();

/**
 * 检测文件编码
 */
async function detectFileEncoding(filepath) {
    try {
        const detectedEncoding = await chardet.detectFile(filepath);
        cookieDebugger.log('Config', 'Detected file encoding', {
            filepath,
            detected: detectedEncoding
        });

        // 转到iconv-lite
        if (detectedEncoding) {
            const encoding = detectedEncoding.toLowerCase();

            if (encoding === 'gb2312' || encoding === 'gbk' || encoding === 'gb18030') {
                return 'gbk';
            }
            if (encoding === 'utf-8' || encoding === 'utf8') {
                return 'utf-8';
            }
            if (encoding === 'utf-16le' || encoding === 'utf16le') {
                return 'utf16le';
            }
            return encoding;
        }
        return null;
    } catch (error) {
        cookieDebugger.error('Config', 'Failed to detect encoding', error);
        return null;
    }
}

/**
 * 读取文件
 */
async function readFileWithEncoding(filepath, defaultEncoding = 'utf-8') {
    try {
        let encoding = await detectFileEncoding(filepath);
        if (!encoding) {
            encoding = defaultEncoding;
            cookieDebugger.log('Config', 'Using default encoding', {
                filepath,
                encoding: defaultEncoding
            });
        }

        // 缓存编码
        const filename = path.basename(filepath);
        fileEncodings.set(filename, encoding);

        // 读取文件
        const buffer = await fs.readFile(filepath);
        let content;
        if (encoding === 'gbk' || encoding === 'gb2312' || encoding === 'gb18030') {
            content = iconv.decode(buffer, 'gbk');
        } else if (encoding === 'utf16le') {
            content = iconv.decode(buffer, 'utf16le');
        } else if (encoding === 'utf-8' || encoding === 'utf8') {
            content = buffer.toString('utf-8');
        } else {
            try {
                content = iconv.decode(buffer, encoding);
            } catch (e) {
                cookieDebugger.log('Config', 'Fallback to default encoding', {
                    filepath,
                    failedEncoding: encoding,
                    defaultEncoding
                });
                if (defaultEncoding === 'gbk') {
                    content = iconv.decode(buffer, 'gbk');
                } else {
                    content = buffer.toString('utf-8');
                }
            }
        }

        cookieDebugger.log('Config', 'File read successfully', {
            filepath,
            encoding,
            contentLength: content.length
        });

        return { content, encoding };
    } catch (error) {
        cookieDebugger.error('Config', 'Failed to read file with encoding', error);
        throw error;
    }
}

/**
 * 写入文件
 */
async function writeFileWithEncoding(filepath, content, fileType) {
    try {
        const filename = path.basename(filepath);
        // 获取缓存编码
        let encoding = fileEncodings.get(filename);

        if (!encoding) {
            encoding = fileType === 'bat' ? 'gbk' : 'utf-8';
        }

        let processedContent = content;

        // 处理换行符
        if (fileType === 'bat') {
            // Windows -- CRLF
            processedContent = content.replace(/\r?\n/g, '\r\n');
        } else {
            // Unix -- LF
            processedContent = content.replace(/\r\n/g, '\n');
        }

        let buffer;
        if (encoding === 'gbk' || encoding === 'gb2312' || encoding === 'gb18030') {
            buffer = iconv.encode(processedContent, 'gbk');
        } else if (encoding === 'utf16le') {
            buffer = iconv.encode(processedContent, 'utf16le');
        } else if (encoding === 'utf-8' || encoding === 'utf8') {
            buffer = Buffer.from(processedContent, 'utf-8');
        } else {
            try {
                buffer = iconv.encode(processedContent, encoding);
            } catch (e) {
                if (fileType === 'bat') {
                    buffer = iconv.encode(processedContent, 'gbk');
                } else {
                    buffer = Buffer.from(processedContent, 'utf-8');
                }
            }
        }

        await fs.writeFile(filepath, buffer);

        cookieDebugger.log('Config', 'File written successfully', {
            filepath,
            encoding,
            bufferLength: buffer.length
        });
    } catch (error) {
        cookieDebugger.error('Config', 'Failed to write file with encoding', error);
        throw error;
    }
}

/**
 * 解析BAT变量
 */
function parseBatFile(content) {
    const lines = content.split(/\r?\n/);
    const variables = [];
    let currentComments = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // 收集注释（REM 或 ::）
        if (line.startsWith('REM ')) {
            currentComments.push(line.substring(4).trim());
        } else if (line.startsWith('::')) {
            currentComments.push(line.substring(2).trim());
        }
        // 解析 set
        else if (line.toLowerCase().startsWith('set ')) {
            const match = line.match(/^set\s+([A-Z_][A-Z0-9_]*)=(.*)$/i);
            if (match) {
                variables.push({
                    name: match[1],
                    value: match[2] || '',
                    comment: currentComments.join('\n'),
                    line: i
                });
                currentComments = [];
            }
        }
        // 空行或其他内容时清空注释
        else if (line && !line.startsWith('REM') && !line.startsWith('::')) {
            currentComments = [];
        }
    }
    
    return variables;
}

/**
 * 解析SH变量
 */
function parseShFile(content) {
    const lines = content.split(/\r?\n/);
    const variables = [];
    let currentComments = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // 收集注释
        if (line.startsWith('#') && !line.startsWith('#!/')) {
            currentComments.push(line.substring(1).trim());
        }
        // 解析 export
        else if (line.toLowerCase().startsWith('export ')) {
            const match = line.match(/^export\s+([A-Z_][A-Z0-9_]*)=(.*)$/i);
            if (match) {
                let value = match[2] || '';
                // 移除引号
                if ((value.startsWith('"') && value.endsWith('"')) || 
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                
                variables.push({
                    name: match[1],
                    value: value,
                    comment: currentComments.join('\n'),
                    line: i
                });
                currentComments = [];
            }
        }
        // 非注释非变量行清空注释
        else if (line && !line.startsWith('#')) {
            currentComments = [];
        }
    }
    
    return variables;
}

/**
 * 更新配置文件变量
 */
function updateConfigFile(content, changes, fileType) {
    const lines = content.split(/\r?\n/);
    const isWindows = fileType === 'bat';
    
    for (const [varName, newValue] of Object.entries(changes)) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (isWindows) {
                const regex = new RegExp(`^(\\s*set\\s+${varName}=)(.*)$`, 'i');
                if (regex.test(line)) {
                    lines[i] = line.replace(regex, `$1${newValue}`);
                    break;
                }
            } else {
                const regex = new RegExp(`^(\\s*export\\s+${varName}=)(.*)$`, 'i');
                if (regex.test(line)) {
                    let quotedValue = newValue;
                    if (newValue.includes(' ') || newValue.includes('$')) {
                        quotedValue = `"${newValue}"`;
                    }
                    lines[i] = line.replace(regex, `$1${quotedValue}`);
                    break;
                }
            }
        }
    }
    
    // 文件类型选择换行符
    const lineEnding = isWindows ? '\r\n' : '\n';
    return lines.join(lineEnding);
}

// API路由

/**
 * 获取可用配置
 */
router.get('/files', async (req, res) => {
    try {
        const files = [];
        
        // 检查 start.bat
        try {
            await fs.access(path.join(PROJECT_ROOT, 'start.bat'));
            files.push('start.bat');
        } catch (e) {
            cookieDebugger.log('Config', 'start.bat not found');
        }
        
        // 检查 start.sh
        try {
            await fs.access(path.join(PROJECT_ROOT, 'start.sh'));
            files.push('start.sh');
        } catch (e) {
            cookieDebugger.log('Config', 'start.sh not found');
        }
        
        cookieDebugger.log('Config', 'Available config files', { files });
        
        res.json({
            success: true,
            files: files
        });
    } catch (error) {
        cookieDebugger.error('Config', 'Failed to check config files', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 加载配置文件
 */
router.get('/load', async (req, res) => {
    try {
        const filename = req.query.file;
        
        if (!filename || !['start.bat', 'start.sh'].includes(filename)) {
            return res.status(400).json({
                success: false,
                error: '无效的文件名'
            });
        }
        
        const filepath = path.join(PROJECT_ROOT, filename);
        const fileType = filename.endsWith('.bat') ? 'bat' : 'sh';

        // 设置默认编码
        const defaultEncoding = fileType === 'bat' ? 'gbk' : 'utf-8';
        
        // 读取
        const { content, encoding } = await readFileWithEncoding(filepath, defaultEncoding);

        // 解析变量
        const variables = fileType === 'bat' 
            ? parseBatFile(content)
            : parseShFile(content);
        
        cookieDebugger.log('Config', 'Loaded config file', { 
            file: filename,
            encoding: encoding,
            variablesCount: variables.length 
        });
        
        res.json({
            success: true,
            content: content,
            variables: variables,
            fileType: fileType,
            encoding: encoding
        });
    } catch (error) {
        cookieDebugger.error('Config', 'Failed to load config file', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 保存配置
 */
router.post('/save', async (req, res) => {
    const { file, mode, changes, content } = req.body;

    if (!file || !['start.bat', 'start.sh'].includes(file)) {
        return res.status(400).json({
            success: false,
            error: '无效的文件名'
        });
    }

    // 设置保存状态
    const saveId = `${file}_${Date.now()}`;
    saveStatus.set(saveId, 'saving');
    res.json({
        success: true,
        message: '配置保存中',
        saveId: saveId
    });

    // 异步
    await (async () => {
        try {
            const filepath = path.join(PROJECT_ROOT, file);
            const fileType = file.endsWith('.bat') ? 'bat' : 'sh';
            const defaultEncoding = fileType === 'bat' ? 'gbk' : 'utf-8';

            let newContent;

            if (mode === 'variables') {
                const { content: originalContent } = await readFileWithEncoding(filepath, defaultEncoding);
                // 变量模式 - 只更新变量值
                newContent = updateConfigFile(originalContent, changes, fileType);
            } else {
                // 完整编辑模式
                newContent = content;
            }
            await writeFileWithEncoding(filepath, newContent, fileType);

            cookieDebugger.log('Config', 'Config file saved successfully', {
                file,
                mode,
                saveId,
                changesCount: mode === 'variables' ? Object.keys(changes).length : null
            });

            // 更新保存状态
            saveStatus.set(saveId, 'completed');

            // 5分钟清理状态
            setTimeout(() => {
                saveStatus.delete(saveId);
            }, 5 * 60 * 1000);

        } catch (error) {
            cookieDebugger.error('Config', 'Failed to save config file', error);
            saveStatus.set(saveId, 'failed');
        }
    })();
});

/**
 * 检查保存状态
 */
router.get('/save-status/:saveId', (req, res) => {
    const { saveId } = req.params;
    const status = saveStatus.get(saveId) || 'unknown';

    res.json({
        success: true,
        status: status
    });
});

/**
 * 检查所有保存
 */
router.post('/check-before-restart', async (req, res) => {
    const { saveIds } = req.body;

    let allCompleted = true;
    let hasFailed = false;

    if (saveIds && saveIds.length > 0) {
        for (const saveId of saveIds) {
            const status = saveStatus.get(saveId);
            if (status === 'saving') {
                allCompleted = false;
            } else if (status === 'failed') {
                hasFailed = true;
            }
        }
    }

    if (hasFailed) {
        res.json({
            success: false,
            error: '配置保存失败，请重试'
        });
    } else if (!allCompleted) {
        let waitCount = 0;
        while (!allCompleted && waitCount < 50) {
            await new Promise(resolve => setTimeout(resolve, 100));
            allCompleted = true;

            for (const saveId of saveIds) {
                const status = saveStatus.get(saveId);
                if (status === 'saving') {
                    allCompleted = false;
                }
            }
            waitCount++;
        }

        res.json({
            success: allCompleted,
            message: allCompleted ? '配置已保存' : '配置正在保存'
        });
    } else {
        res.json({
            success: true,
            message: '重启...'
        });
    }
});

export default router;