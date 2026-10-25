/**
 * Electron 预加载脚本。
 *
 * 通过 contextBridge 向渲染进程暴露最小能力：
 *  - 打开文件对话框并读取音频
 *  - 保存 WAV 文件
 *  - 应用信息
 */
const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

contextBridge.exposeInMainWorld('morseDesktop', {
  isDesktop: true,
  platform: process.platform,

  /** 打开音频文件，返回 { name, data: ArrayBuffer } */
  async openAudioFile() {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      title: '选择音频文件',
      filters: [
        {
          name: '音频文件',
          extensions: ['wav', 'mp3', 'ogg', 'm4a', 'flac', 'aac'],
        },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const file = result.filePaths[0];
    const buf = fs.readFileSync(file);
    // 转成 ArrayBuffer 以便跨进程传递（结构化克隆支持 ArrayBuffer）
    return {
      name: path.basename(file),
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  },

  /** 保存 WAV 文件 */
  async saveWav(name, arrayBuffer) {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog({
      title: '保存 WAV',
      defaultPath: name || 'morse.wav',
      filters: [{ name: 'WAV 音频', extensions: ['wav'] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, Buffer.from(arrayBuffer));
    return true;
  },

  /** 监听主进程菜单事件 */
  onMenu(channel, callback) {
    const allowed = ['open-audio-file', 'export-wav'];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  /** 应用信息 */
  getVersion: () => process.versions.electron,
});
