import {exec, execSync} from 'child_process';
import {promisify} from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {fileURLToPath} from 'url';
import {setupBrowserFingerprint} from './browserFingerprint.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execPromise = promisify(exec);

/**
 * @param {string} userDataDir - 用户数据目录
 * @param {string} edgePath - Edge浏览器路径
 * @param {number} debugPort - 调试端口
 * @param env
 * @returns {Promise<object>} - browser和page
 */
export async function launchEdgeBrowser(userDataDir, edgePath, debugPort = 9222, env = {}) {
    if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, {recursive: true});
    }

    const remoteDebuggingPort = debugPort;
    let edgeProcess;

    const args = [
        `--remote-debugging-port=${remoteDebuggingPort}`,
        `--user-data-dir="${userDataDir}"`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
        '--disable-infobars',
        '--disable-translate',
        '--disable-sync',
        '--window-size=1280,850',
        '--force-device-scale-factor=1',
        'about:blank'  // 打开空白页
    ];

    try {
        // 启动Edge浏览器
        const cmdArgs = args.join(' ');
        const cmd = `"${edgePath}" ${cmdArgs}`;

        // 环境变量启动进程
        edgeProcess = exec(cmd, {
            env: {
                ...process.env,
                ...env
            }
        });

        console.log(`等待Edge浏览器启动... (DISPLAY=${env.DISPLAY || process.env.DISPLAY})`);
        await new Promise(resolve => setTimeout(resolve, 3000));

        const puppeteer = await import('puppeteer-core');

        // 连接到浏览器
        const browser = await puppeteer.connect({
            browserURL: `http://127.0.0.1:${remoteDebuggingPort}`,
            defaultViewport: {width: 1280, height: 850}
        });

        // 获取第一个页面
        const pages = await browser.pages();
        let page = pages[0];
        if (!page) {
            page = await browser.newPage();
        }

        // 应用随机指纹
        const fingerprint = await setupBrowserFingerprint(page, 'edge');

        return {
            browser,
            page,
            process: edgeProcess,
            fingerprint: fingerprint
        };
    } catch (error) {
        console.error(`启动Edge浏览器失败:`, error);

        if (edgeProcess) {
            try {
                edgeProcess.kill();
            } catch (e) {
            }
        }

        throw error;
    }
}

/**
 * 查找Edge浏览器路径
 * @returns {string|null}
 */
export function findEdgePath() {
    const platform = os.platform();

    if (platform === 'win32') {
        const commonPaths = [
            `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
            `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
            `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
            `C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe`,
            `C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe`
        ];

        for (const path of commonPaths) {
            if (fs.existsSync(path)) {
                return path;
            }
        }
    } else if (platform === 'darwin') {
        const macPath = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
        if (fs.existsSync(macPath)) {
            return macPath;
        }
    } else {
        // Linux
        try {
            const {stdout} = execSync('which microsoft-edge');
            if (stdout && stdout.trim()) {
                return stdout.trim();
            }
        } catch (e) {
        }
    }
    return null;
}