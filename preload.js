'use strict';

// 安全桥：仅暴露本地 API 地址与少量受控事件，不暴露任何 Node API。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  baseUrl: 'http://127.0.0.1:3000',
  // 主进程（托盘"立即签到"菜单）触发时回调，用于自动点击签到按钮
  onTriggerCheckin: (cb) => {
    ipcRenderer.on('trigger-checkin', () => cb());
  },
  // 主进程完成一次自动签到后回调，用于刷新界面统计
  onCheckinDone: (cb) => {
    ipcRenderer.on('checkin-done', (_e, payload) => cb(payload));
  },
});
