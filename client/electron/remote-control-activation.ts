/**
 * 远程控制授权结果。与 remote-control.ts 分开存放是刻意的：渲染进程要引用这个
 * 类型，而 remote-control.ts 会 import child_process / fs；一旦被渲染进程的类型图
 * 拉进来，Node 的全局 setTimeout 重载会覆盖 DOM 的，连带破坏其它文件的类型。
 */
export type RemoteControlActivation =
  | { ok: true }
  | { ok: false; reason: string };
