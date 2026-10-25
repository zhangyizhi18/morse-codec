/**
 * 麦克风采集的底层逻辑。
 *
 * 单独成模块，便于 AudioWorklet 与 ScriptProcessor 两条路径共用。
 */

/**
 * 获取麦克风流（自动处理运行时权限 + 多策略回退）。
 *
 * Android 上必须先申请 RECORD_AUDIO 运行时权限，
 * 否则 getUserMedia 会直接失败（NotAllowedError）。
 *
 * 真机上还可能遇到：
 *  - NotReadableError: AudioRecord 启动失败
 *      · 缺 MODIFY_AUDIO_SETTINGS（已在 Manifest 声明）
 *      · 其它应用正在占用麦克风
 *      · 部分 ROM 需要显式指定 deviceId 才能选中输入设备
 *      · 需要 `AUDIO_SOURCE_VOICE_RECOGNITION` 而非默认的 MIC
 *  - NotFoundError: 没有可用输入设备
 *
 * 因此这里按「默认 → 放宽约束 → 枚举设备」多级回退。
 */
export async function getMicrophoneStream(): Promise<MediaStream> {
  const md = navigator.mediaDevices;
  // 必须绑定 this：脱离 navigator.mediaDevices 上下文调用会抛
  // "Illegal invocation"（WebIDL 规范要求）
  const gUM = md.getUserMedia.bind(md);

  /**
   * 依次尝试的约束组合。
   *
   * 关键：优先关闭 AGC / 降噪 / 回声消除。
   * 这些音频处理链会压缩摩斯信号的动态包络（点与划的幅度差异、
   * 静音段与信号段的对比度），导致实时解码时点划边界判断错误。
   * 摩斯是「开关键控」信号，本来就不需要这些处理。
   */
  const attempts: MediaStreamConstraints[] = [
    // 首选：关闭所有会扭曲包络的处理链
    {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    },
    // 次选：再指定采样率与声道数
    {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100,
        channelCount: 1,
      },
    },
    // 兜底：系统默认（部分 ROM 不接受上面的约束）
    { audio: true },
    // 最后：最低约束
    { audio: false },
  ];

  let lastError: unknown = null;

  for (const constraints of attempts) {
    try {
      // getUserMedia 本身就会触发 Android 的权限流程，
      // 因此不需要先单独申请权限（那样会挂起等待系统对话框）。
      return await gUM(constraints);
    } catch (e) {
      lastError = e;
      const name = (e as DOMException)?.name;
      // NotAllowedError 是权限问题，换约束无意义
      if (name === 'NotAllowedError' || name === 'SecurityError') break;
    }
  }

  // 全部失败：若设备有多个输入设备，尝试逐个指定
  try {
    const devices = await md.enumerateDevices.call(md);
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    for (const input of inputs) {
      try {
        return await gUM({
          audio: { deviceId: { exact: input.deviceId } },
        });
      } catch {
        /* 试下一个 */
      }
    }
  } catch {
    /* enumerateDevices 也可能不可用 */
  }

  throw describeMicrophoneError(lastError);
}

/**
 * 麦克风诊断信息（供 UI 展示与问题排查）。
 */
export interface MicrophoneDiagnostic {
  /** 平台 */
  platform: string;
  /** 是否有 mediaDevices */
  hasMediaDevices: boolean;
  /** 是否为安全上下文（HTTPS/localhost） */
  secureContext: boolean;
  /** 权限状态 */
  permissionState: string;
  /** 枚举到的输入设备 */
  inputDevices: { deviceId: string; label: string }[];
  /** 最后一次错误 */
  lastError?: string;
}

/**

/** 把 DOMException 翻译成用户能看懂的中文提示 */
export function describeMicrophoneError(err: unknown): Error {
  const e = err as DOMException | undefined;
  const name = e?.name ?? '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error('麦克风权限被拒绝，请在系统设置中为「摩斯电码」开启麦克风权限');
  }
  if (name === 'NotFoundError') {
    return new Error('未检测到麦克风设备');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new Error(
      '麦克风启动失败：可能正被其它应用占用，或该设备不支持 WebView 录音',
    );
  }
  if (name === 'OverconstrainedError') {
    return new Error('没有满足所请求参数的麦克风设备');
  }
  return new Error(e?.message || '无法访问麦克风');
}
