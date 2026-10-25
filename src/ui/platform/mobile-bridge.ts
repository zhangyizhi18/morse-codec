/**
 * 移动端（Capacitor / Android）文件保存桥接。
 *
 * 使用原生插件把音频写入设备存储，并调起系统分享面板，
 * 让用户把文件保存到「下载 / 音乐 / 文件」等目录或直接发送。
 *
 * 依赖：
 *  - @capacitor/filesystem : 写入文件到 Directory.Documents / Cache
 *  - @capacitor/share      : 调起系统分享面板
 */

/** 导出结果 */
export interface ExportResult {
  /** 是否成功 */
  ok: boolean;
  /** 保存位置描述（用于 UI 提示） */
  location: string;
  /** 可分享的 URI（若支持） */
  uri?: string;
}

/** 运行环境探测 */
export function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
  return cap?.isNativePlatform?.() ?? false;
}

/**
 * 把 WAV 数据保存到设备并调起分享。
 *
 * 流程：
 *  1. 写入 Cache 目录（临时可写，无需权限）
 *  2. 通过 FileProvider 得到 content:// URI
 *  3. 调起系统分享面板，用户可选择「保存到下载」「文件」等
 *
 * @param filename 文件名（含 .wav）
 * @param data WAV 数据
 */
export async function saveWavNative(
  filename: string,
  data: ArrayBuffer,
): Promise<ExportResult> {
  // 动态导入，避免 Web 端打包时引入原生代码
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');

  const base64 = arrayBufferToBase64(data);

  // 不传 encoding => 按二进制写入（插件内部会对 base64 解码）
  const written = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  });

  // 调起系统分享面板
  try {
    await Share.share({
      title: '摩斯电码音频',
      text: filename,
      url: written.uri,
      dialogTitle: '保存或分享摩斯电码音频',
    });
    return { ok: true, location: '已保存并打开分享面板', uri: written.uri };
  } catch {
    // 用户取消分享不算失败 —— 文件已写入
    return {
      ok: true,
      location: `已保存至应用缓存目录：${written.uri}`,
      uri: written.uri,
    };
  }
}

/**
 * 把 WAV 直接保存到公共文档目录（部分设备可见于「文件」应用）。
 *
 * Android 10+ 的分区存储下，写入公共目录需要 MediaStore 支持，
 * Capacitor Filesystem 的 Directory.Documents 映射到应用专属外部目录，
 * 同样可通过分享面板导出。
 */
export async function saveWavToDocuments(
  filename: string,
  data: ArrayBuffer,
): Promise<ExportResult> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const base64 = arrayBufferToBase64(data);

  const written = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Documents,
  });

  return {
    ok: true,
    location: `已保存至文档目录：${written.uri}`,
    uri: written.uri,
  };
}

/** ArrayBuffer -> Base64（分块处理，避免大文件爆栈） */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
