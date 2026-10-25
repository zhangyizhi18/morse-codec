/// <reference types="vite/client" />

/**
 * AudioWorklet 模块的导入声明。
 * 使用 ?url 后缀让 Vite 把脚本作为独立资源打包并返回其地址。
 */
declare module '*.js?url' {
  const url: string;
  export default url;
}
