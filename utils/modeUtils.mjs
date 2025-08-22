/**
 * 根据环境变量计算模式状态
 * @returns {{default: boolean, custom: boolean}}
 */
export function getModeStatus() {
    const useCustomMode = process.env.USE_CUSTOM_MODE === 'true';
    const enableRotation = process.env.ENABLE_MODE_ROTATION === 'true';

    if (useCustomMode && enableRotation) {
        // 轮换
        return { default: true, custom: true };
    } else if (useCustomMode) {
        // 仅自定义
        return { default: false, custom: true };
    } else {
        // 仅默认
        return { default: true, custom: false };
    }
}

/**
 * 获取初始模式
 * @returns {string} 'default' 或 'custom'
 */
export function getInitialMode() {
    const modeStatus = getModeStatus();

    if (modeStatus.custom && !modeStatus.default) return 'custom';
    if (modeStatus.default && !modeStatus.custom) return 'default';

    return process.env.USE_CUSTOM_MODE === 'true' ? 'custom' : 'default';
}