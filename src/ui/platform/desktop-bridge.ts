/**
 * 桌面端（Electron）桥接。
 *
 * 在 Electron 中通过 window.morseDesktop 访问原生能力；
 * 在 Android WebView 中该对象不存在，此时全部降级为 Web API。
 */

export interface DesktopBridge {
  isDesktop: boolean;
  platform: string;
  openAudioFile(): Promise<{ name: string; data: ArrayBuffer } | null>;
  saveWav(name: string, arrayBuffer: ArrayBuffer): Promise<boolean>;
  onMenu(channel: string, cb: (...args: unknown[]) => void): () => void;
  getVersion(): string;
}

declare global {
  interface Window {
    morseDesktop?: DesktopBridge;
  }
}

/** 是否运行在 Electron 中 */
export const isDesktop = (): boolean =>
  typeof window !== 'undefined' && !!window.morseDesktop;

/** 获取桥接对象（不存在则返回 null） */
export function getDesktop(): DesktopBridge | null {
  return typeof window !== 'undefined' ? (window.morseDesktop ?? null) : null;
}

/**
 * 打开音频文件。
 * 桌面端走原生对话框；其它平台走 <input type=file>。
 */
export async function pickAudioFile(): Promise<{
  name: string;
  data: ArrayBuffer;
} | null> {
  const desktop = getDesktop();
  if (desktop) return desktop.openAudioFile();
  return null;
}

/**
 * 保存 WAV。
 *
 * 分平台处理：
 *  - Electron 桌面端：原生「另存为」对话框
 *  - Android (Capacitor)：写入应用目录 + 调起系统分享面板
 *  - 纯 Web：<a download> 触发浏览器下载
 *
 * @returns 导出结果描述（用于 UI 提示）
 */
export async function saveWav(
  filename: string,
  arrayBuffer: ArrayBuffer,
): Promise<{ ok: boolean; location: string }> {
  const desktop = getDesktop();
  if (desktop) {
    const ok = await desktop.saveWav(filename, arrayBuffer);
    return { ok, location: ok ? '已保存到所选位置' : '已取消' };
  }

  // Android / 原生容器
  const { isNativePlatform, saveWavNative } = await import('./mobile-bridge');
  if (isNativePlatform()) {
    try {
      const r = await saveWavNative(filename, arrayBuffer);
      return { ok: r.ok, location: r.location };
    } catch (e) {
      return {
        ok: false,
        location: (e as Error).message || '保存失败',
      };
    }
  }

  // 纯 Web 降级：触发下载
  const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true, location: '已触发浏览器下载' };
}

/**
 * 监听桌面端菜单事件。
 */
export function onDesktopMenu(
  channel: string,
  cb: (...args: unknown[]) => void,
): () => void {
  const desktop = getDesktop();
  if (!desktop) return () => {};
  return desktop.onMenu(channel, cb);
}
