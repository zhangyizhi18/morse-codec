/**
 * Electron 主进程（PC 端）。
 *
 * 职责：
 *  - 创建窗口加载打包后的前端
 *  - 提供原生菜单（文件 / 编辑 / 视图 / 帮助）
 *  - 实现「另存为 WAV」等需要 Node 能力的操作
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

/** 主窗口 */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    title: '摩斯电码 · 调制解调',
    backgroundColor: '#0b1220',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  // 显示后再加载，避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    mainWindow.loadFile(indexPath);
  } else {
    mainWindow.loadURL(
      process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173',
    );
  }

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 构建菜单 */
function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开音频文件…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            if (!mainWindow) return;
            dialog
              .showOpenDialog(mainWindow, {
                title: '选择音频文件',
                filters: [
                  { name: '音频文件', extensions: ['wav', 'mp3', 'ogg', 'm4a', 'flac', 'aac'] },
                  { name: '所有文件', extensions: ['*'] },
                ],
                properties: ['openFile'],
              })
              .then(({ canceled, filePaths }) => {
                if (canceled || filePaths.length === 0) return;
                // 通过 URL hash 通知前端（前端监听 hashchange）
                const file = filePaths[0];
                mainWindow.webContents.send('open-audio-file', file);
              });
          },
        },
        {
          label: '导出 WAV…',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            if (!mainWindow) return;
            mainWindow.webContents.send('export-wav');
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: '摩斯电码 · 调制解调 v1.0.0',
              detail:
                '支持国际摩斯电码、中文电码（大陆/台湾香港）、俄语摩斯电码、日语和文电码。\n' +
                '输入文字生成音频，导入音频解出文字。',
              buttons: ['好的'],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 单实例锁
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
