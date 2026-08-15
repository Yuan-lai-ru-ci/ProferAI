/** Shared semantic actions emitted by keyboard navigation. */
export type NavigationAction =
  | 'previous'
  | 'next'
  | 'left'
  | 'right'
  | 'confirm'
  | 'back'
  // Alt/Option 与左右组合：在模式切换区直接切换 Agent↔Chat（区别于普通左右只预选）。
  | 'altLeft'
  | 'altRight'
