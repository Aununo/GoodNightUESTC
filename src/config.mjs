import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
export const DEFAULTS = Object.freeze({ version: 1, reportTime: '22:30', sessionIntervalMinutes: 10, catchUpMinutes: 30, browserChannel: 'chrome', headless: true, frontendLocationExport: 'auto', maxAccuracyMeters: 200, preflightLeadMinutes: 20, recoveryIntervalMinutes: 10, recoveryCutoff: '23:30', notifications: true, submissionsEnabled: false, locationProvider: 'browser', fixedLocation: null, autoRelogin: false });

export function configuredLocation(config) {
  if (config.locationProvider !== 'fixed') return null;
  const value = config.fixedLocation;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !['latitude', 'longitude', 'accuracy'].includes(k))
      || ![value.latitude, value.longitude, value.accuracy].every(Number.isFinite)
      || Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180
      || value.accuracy < 0 || value.accuracy > config.maxAccuracyMeters) {
    throw new Error('固定定位必须填写有效的 GCJ-02 经纬度及精度，且精度不得超出 maxAccuracyMeters');
  }
  return { latitude: value.latitude, longitude: value.longitude, accuracy: value.accuracy };
}
export function defaultDataDir({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const paths=platform==='win32'?path.win32:path.posix;
  if (env.GOODNIGHT_HOME) return paths.resolve(env.GOODNIGHT_HOME);
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support', 'GoodNight');
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'GoodNight');
  return paths.join(env.XDG_STATE_HOME || paths.join(home, '.local', 'state'), 'goodnight');
}
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是 JSON 对象');
  if (Object.keys(input).some(k => !Object.hasOwn(DEFAULTS, k))) throw new Error('配置包含未知字段，请参考 config.example.json');
  const c = { ...DEFAULTS, ...input };
  if (c.version !== 1) throw new Error('不支持的配置版本');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(c.reportTime)) throw new Error('时间必须是 HH:mm（上海时间）');
  if (!Number.isInteger(c.sessionIntervalMinutes) || c.sessionIntervalMinutes < 1 || c.sessionIntervalMinutes > 30) throw new Error('会话检查间隔必须为1–30分钟');
  if (!Number.isInteger(c.catchUpMinutes) || c.catchUpMinutes < 1 || c.catchUpMinutes > 120) throw new Error('补执行窗口必须为1–120分钟');
  if (!Number.isInteger(c.preflightLeadMinutes) || c.preflightLeadMinutes < 1 || c.preflightLeadMinutes > 120) throw new Error('预检提前量必须为1–120分钟');
  if (!Number.isInteger(c.recoveryIntervalMinutes) || c.recoveryIntervalMinutes < 1 || c.recoveryIntervalMinutes > 30) throw new Error('补执行检查间隔必须为1–30分钟');
  if (typeof c.recoveryCutoff !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(c.recoveryCutoff) || c.recoveryCutoff > '23:55' || c.recoveryCutoff <= c.reportTime) throw new Error('补执行截止须晚于每日时间且不晚于23:55');
  if (typeof c.notifications !== 'boolean') throw new Error('notifications 必须是布尔值');
  if (typeof c.submissionsEnabled !== 'boolean') throw new Error('submissionsEnabled 必须是布尔值');
  if (typeof c.autoRelogin !== 'boolean') throw new Error('autoRelogin 必须是布尔值');
  if (!['browser', 'fixed'].includes(c.locationProvider)) throw new Error('locationProvider 必须是 browser 或 fixed');
  if (c.locationProvider === 'browser' && c.fixedLocation !== null) throw new Error('使用浏览器定位时 fixedLocation 必须为 null');
  if (c.locationProvider === 'fixed') configuredLocation(c);
  if (!['chrome', 'msedge', 'chromium'].includes(c.browserChannel)) throw new Error('浏览器必须为 chrome、msedge 或 chromium');
  if (typeof c.headless !== 'boolean') throw new Error('headless 必须是布尔值');
  if (typeof c.frontendLocationExport !== 'string' || !/^[\w$]{1,80}$/.test(c.frontendLocationExport)) throw new Error('定位导出名无效');
  if (!Number.isFinite(c.maxAccuracyMeters) || c.maxAccuracyMeters < 1 || c.maxAccuracyMeters > 5000) throw new Error('最大定位误差必须为1–5000米');
  return c;
}
export function loadConfig(dataDir) {
  let input;
  try { input = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw new Error('尚未配置，请先运行 init'); throw new Error('无法读取 config.json，请检查 JSON 格式和权限'); }
  return validateConfig(input);
}
