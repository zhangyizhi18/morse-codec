/**
 * 码表（codebook）类型定义
 *
 * 支持三种编码体系：
 *  - morse    : 国际摩斯电码，值为点划串，如 ".-"
 *  - telegraph: 中文电码（商业电码），值为 4 位数字，如 "0022"
 *  - mixed    : 中英混合。拉丁字母直接发点划，汉字发 4 位电码数字，
 *               两者靠「码组间隔」区分（详见 morse-mixed.ts）
 *
 * 俄语/日语等使用拉丁或西里尔/假名字符，通过 morse 体系承载。
 */

/** 编码体系类型 */
export type CodeSystem = 'morse' | 'telegraph' | 'mixed';

/** 码表条目方向 */
export type Direction = 'encode' | 'decode' | 'bidirectional';

/** 码表定义 */
export interface Codebook {
  /** 唯一标识，如 "en", "zh-CN" */
  id: string;
  /** 显示名称，如 "English", "中文电码（大陆）" */
  name: string;
  /** 本地化显示名（可选） */
  displayName?: string;
  /** 编码体系 */
  system: CodeSystem;
  /** 支持方向 */
  direction: Direction;
  /** 数据版本 */
  version: string;
  /** 数据来源说明 */
  source?: string;
  /** 授权协议 */
  license?: string;
  /**
   * 字符 -> 电码。
   *  - morse    : 值形如 ".-"
   *  - telegraph: 值形如 "0022"
   *  - mixed    : 两者混排。拉丁字母为点划串，汉字为 4 位数字串。
   *               因点划串只含 ".-"、数字码只含 "0-9"，格式本身即可区分，
   *               无需额外标记。
   */
  entries: Record<string, string>;
  /** 电码 -> 字符（反向索引，构建时自动生成） */
  reverse: Record<string, string>;
  /**
   * 间隔方案（单位数）。
   *  - morse   : char=3 (字符间隔), word=7 (词间隔)
   *  - telegraph: char=3 (数字间隔), group=5 (4位码组间隔), word=9 (词间隔)
   */
  gaps?: GapScheme;
  /**
   * 码长（数字位数）。仅 telegraph 体系需要。
   *  - 中文电码: [4]
   *  - 和文电码: [2]
   * 默认 [4]
   */
  codeLengths?: number[];
}

/** 间隔方案（单位数） */
export interface GapScheme {
  /** 字符/数字级间隔 */
  char: number;
  /** 码组间隔（仅 telegraph 需要） */
  group?: number;
  /** 词间隔 */
  word: number;
}

/** 码表元信息（不含 entries，用于 UI 下拉列表） */
export type CodebookMeta = Omit<Codebook, 'entries' | 'reverse'>;

/**
 * 摩斯码表接口：一个字符可对应多个电码（歧义）时的表示。
 * 简单码表用 Record<string,string> 即可；复杂场景（如中文电码无歧义）也适用。
 */

/** 编码参数 */
export interface EncodeOptions {
  /** 速度，字/分钟 (WPM)。中文电码使用「码/分钟」语义时同样适用 */
  wpm: number;
  /** 音高 Hz */
  frequency: number;
  /** 音量 0~1 */
  volume: number;
  /** 是否输出词间隔 */
  wordSpacing?: boolean;
}

/** 解码参数 */
export interface DecodeOptions {
  /**
   * 阈值策略：
   *  - auto  : Otsu 自适应阈值（推荐，鲁棒）
   *  - fixed : 固定阈值
   */
  thresholdMode?: 'auto' | 'fixed';
  /** 固定阈值模式下的阈值 (0~1) */
  threshold?: number;
  /** 包络窗口大小 ms */
  windowMs?: number;
  /** 中值滤波窗口（半宽），0 表示不滤波 */
  medianRadius?: number;
}

/** 时序元素类型 */
export type ElementKind = 'dot' | 'dash' | 'gap';

/** 时序元素 */
export interface TimedElement {
  kind: ElementKind;
  /** 时长（毫秒） */
  durationMs: number;
}

/** 解码结果 */
export interface DecodeResult {
  /** 解出的文本 */
  text: string;
  /** 摩斯点划串（以 / 分隔字符，| 分隔词） */
  morse: string;
  /** 识别到的字符数 */
  charCount: number;
  /** 置信度 0~1 */
  confidence: number;
  /** 检测到的 dot 时长（ms），用于反推 WPM */
  detectedDotMs: number | null;
  /** 实际使用的阈值 */
  threshold: number;
  /** 无法识别的码字数量 */
  unknownCount: number;
  /** 原始游程（调试/可视化用） */
  runs?: RunSegment[];
}

/** 游程段 */
export interface RunSegment {
  /** true = 有信号，false = 静音 */
  on: boolean;
  /** 长度（帧数） */
  length: number;
}

/** 分隔级别 */
export type SeparatorLevel = 'char' | 'group' | 'word';
