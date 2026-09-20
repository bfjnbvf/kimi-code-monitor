/**
 * 独立面板的状态文案：把各环节原始状态归并成一个等级 + 说人话的句子。
 *
 * 等级（严重度从高到低）：
 *   error      渲染层报错 / 数据文件加载失败——需要处理
 *   failing    本地服务断开且重试超过 30s
 *   connecting 本地服务未连上（kap 源未知 / 事件流断开）
 *   ok         历史或页内积累任一就绪（锁隐藏，正常显示）
 *   fresh      管道健康但没有历史数据（全新环境，从现在开始统计）
 *   loading    刚启动，什么都还没到
 *
 * 文案两版：LONG 给消耗量锁位（空间较大），SHORT 给吉祥物旁等窄位。
 * 键为中文原文，英文在 i18n.js。
 */

export const STATUS_LONG = {
  loading: '正在加载数据统计…',
  fresh: '暂无历史数据，从现在开始统计',
  connecting: '本地服务连接中，正在重试…',
  failing: '连接本地服务失败，正在自动重试',
  error: '数据显示异常，可让 Kimi 帮忙自检'
};

export const STATUS_SHORT = {
  loading: '统计中…',
  fresh: '统计中…',
  connecting: '连接中…',
  failing: '连接中…',
  error: '异常'
};

const DISCONNECT_MS = 30_000;

/**
 * @param {object} s 各环节原始状态（均可缺省）
 * @param {string} [s.dispatchError] 渲染层记录的异常信息
 * @param {boolean} [s.connected] 面板已拿到历史或积累数据
 * @param {boolean} [s.usageDailyOk] 历史数据已进渲染层
 * @param {boolean} [s.hasAccum] 页内已积累到任何按天数据
 * @param {string} [s.fileState] 数据文件状态（载入中/已载入/无历史/加载失败）
 * @param {boolean} [s.kapKnown] 本地服务地址是否已知
 * @param {string} [s.wsState] 事件流状态（open/connecting/closed(rN)/等kap源…）
 * @param {number} [s.connectingMs] 本次断开已持续的毫秒数（调用方跟踪）
 * @returns {'error'|'failing'|'connecting'|'ok'|'fresh'|'loading'}
 */
export function summarizeStatus(s = {}) {
  if (s.dispatchError) return 'error';
  if (s.fileState === '加载失败') return 'error';
  const wsState = String(s.wsState || '');
  const disconnected = s.kapKnown === false
    || wsState.startsWith('closed')
    || wsState === '等kap源';
  if (disconnected) return Number(s.connectingMs) >= DISCONNECT_MS ? 'failing' : 'connecting';
  if (s.connected || s.usageDailyOk || s.hasAccum) return 'ok';
  if (s.fileState === '无历史') return 'fresh';
  return 'loading';
}
