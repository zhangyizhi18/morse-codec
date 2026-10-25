/**
 * 权限桥接。
 *
 * Android (Capacitor)：通过自定义原生插件 `MorsePermissions` 查询/申请麦克风权限。
 *   —— Capacitor 8 移除了官方 @capacitor/permissions 插件，故自行实现。
 *
 * 其它平台（Electron / 纯 Web）：使用标准 Permissions API（若可用）。
 */

/** 权限状态 */
export type PermissionState =
  | 'granted'
  | 'denied'
  | 'prompt'
  | 'prompt-with-rationale'
  | 'unknown';

/** 归一化权限状态（原生侧返回大写枚举，Web 侧返回小写） */
function normalizeState(state: unknown): PermissionState {
  if (typeof state !== 'string') return 'unknown';
  const s = state.toLowerCase();
  if (
    s === 'granted' ||
    s === 'denied' ||
    s === 'prompt' ||
    s === 'prompt-with-rationale'
  ) {
    return s as PermissionState;
  }
  return 'unknown';
}

/** 运行时平台探测 */
export function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (
    window as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean };
    }
  ).Capacitor;
  return cap?.isNativePlatform?.() ?? false;
}

/** 取得 Capacitor 全局对象 */
function capacitor(): any {
  return (window as unknown as { Capacitor?: any }).Capacitor;
}

/**
 * 取得原生插件代理。
 *
 * Capacitor 8 中插件通过 `cap.registerPlugin(name)` 获取代理；
 * 不能假设 `cap.Plugins[name]` 一定存在（虽然原生侧注册后通常会注入，
 * 但自定义插件未在 JS 侧 registerPlugin 时该属性可能缺失）。
 */
function getNativePlugin(name: string): any {
  const cap = capacitor();
  if (!cap) return null;

  // 优先用已注入的实例
  const injected = cap.Plugins?.[name];
  if (injected) return injected;

  // 否则用 registerPlugin 取代理
  if (typeof cap.registerPlugin === 'function') {
    try {
      return cap.registerPlugin(name);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 查询麦克风权限状态。
 */
export async function checkMicrophonePermission(): Promise<PermissionState> {
  if (isNativePlatform()) {
    try {
      const plugin = getNativePlugin('MorsePermissions');
      if (!plugin) return 'denied';
      const res = await plugin.check({ alias: 'microphone' });
      return normalizeState(res?.state);
    } catch (e) {
      console.warn('权限查询失败:', e);
      return 'denied';
    }
  }

  // Web 端：navigator.permissions
  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
      return status.state as PermissionState;
    }
  } catch {
    /* 部分浏览器不支持查询 microphone */
  }
  return 'unknown';
}

/**
 * 申请麦克风权限。
 *
 * @returns 是否已授权
 */
export async function requestMicrophonePermission(): Promise<boolean> {
  if (isNativePlatform()) {
    try {
      const plugin = getNativePlugin('MorsePermissions');
      if (!plugin) return false;
      const res = await plugin.request({ alias: 'microphone' });
      return normalizeState(res?.state) === 'granted';
    } catch (e) {
      console.warn('权限申请失败:', e);
      return false;
    }
  }

  // Web 端：直接调 getUserMedia 触发权限弹窗
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保麦克风权限可用，不可用则尝试申请。
 *
 * ## 关键设计
 *
 * Android 上不必先走原生插件申请权限 —— 直接尝试 `getUserMedia` 即可：
 * WebView 会自行触发系统权限流程，且在已授权时立即成功。
 *
 * 之前先用原生插件 `request` 会出问题：该调用会挂起等待用户点击系统对话框，
 * 在某些情况下（自动化测试、对话框被遮挡、ROM 差异）不会回调，
 * 导致整个「开始监听」流程卡住。
 *
 * 现在改为：先查状态 → 若非 granted，直接尝试 getUserMedia（它会触发权限流程）。
 *
 * @param onDenied 权限被拒时的回调（用于提示用户去系统设置开启）
 * @returns 是否可以访问麦克风
 */
export async function ensureMicrophoneAccess(
  onDenied?: (state: PermissionState) => void,
): Promise<boolean> {
  const state = await checkMicrophonePermission();
  if (state === 'granted') return true;

  // 未授权：直接尝试打开麦克风，WebView 会自行触发权限流程。
  // 成功即说明权限已授予（或用户刚刚同意）。
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      // 明确被拒
      onDenied?.(state);
      return false;
    }
    // 其它错误（如设备被占用）交由上层处理具体信息
    onDenied?.(state);
    return false;
  }
}
