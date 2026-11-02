#!/usr/bin/env node
// Forced command for an owner-installed, restricted iPhone SSH public key.
// The account comes from authorized_keys, never from a client-supplied command.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateAccountId, selectAccount } from '../src/accounts.mjs';
import { defaultDataDir } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { readTicketStdin } from '../src/ticket-input.mjs';

const reasons = new Set(['invalid_checkin_ticket','invalid_authorization_url','checkin_ticket_rejected',
  'checkin_ticket_missing','checkin_ticket_unreadable','checkin_identity_unavailable',
  'checkin_ticket_identity_mismatch','school_identity_unavailable',
  'account_identity_mismatch','school_identity_already_registered']);
const inputErrors = new Map([
  ['票据标准输入需通过管道或 SSH 输入传入，不能在回显终端中输入','ticket_input_tty'],
  ['票据输入超过 32 KiB 限制','ticket_input_too_large'],
  ['无法读取票据标准输入','ticket_input_failed'],
  ['票据标准输入意外关闭','ticket_input_closed'],
  ['读取票据输入超时；请检查快捷指令是否传入剪贴板','ticket_input_timeout'],
]);
let store, action = 'denied', inputMetadata;
function audit(result, exitCode, reason) {
  try {
    const entry = { at: new Date().toISOString(), action, result, exitCode,
      ...(reason ? {reason} : {}), ...(inputMetadata || {}) };
    store?.write('last-iphone-request.json', entry);
    store?.log('iphone_request', entry);
  } catch { /* Reporting to the owner must still work if audit storage fails. */ }
}
function reply(value, exitCode) {
  // Shortcuts consumes stdout as a File; stderr-only failures can look blank.
  console.log(JSON.stringify(value, null, 2));
  audit(value.result || 'status_read', exitCode, value.reason);
  process.exitCode = exitCode;
}

try {
  const [account, ...extra] = process.argv.slice(2);
  if (extra.length || !account) throw new Error('invalid_account');
  validateAccountId(account);
  const rootDir = defaultDataDir();
  store = new Store(selectAccount(rootDir, account).dataDir);
  const command = process.env.SSH_ORIGINAL_COMMAND?.trim();
  if (!['goodnight-authorize', 'goodnight-status'].includes(command)) throw new Error('invalid_command');
  action = command === 'goodnight-authorize' ? 'authorize' : 'status';
  audit('started', null);
  const args = [fileURLToPath(new URL('../bin/goodnight.mjs', import.meta.url)),
    action, '--account', account, '--data-dir', rootDir];
  if (command === 'goodnight-authorize') args.push('--ticket-stdin');
  let input;
  if (action === 'authorize') {
    input = await readTicketStdin(process.stdin);
    const text = input.trim();
    inputMetadata = { receivedBytes: Buffer.byteLength(input),
      inputKind: !text ? 'empty' : /^https?:\/\//i.test(text) ? 'url'
        : text.startsWith('<') ? 'html_or_xml' : /\s/.test(text) ? 'other_text' : 'opaque' };
  }
  const child = spawnSync(process.execPath, args, {
    input, stdio: ['pipe','pipe','pipe'], shell: false, encoding: 'utf8', maxBuffer: 262144,
  });
  const exitCode = Number.isInteger(child.status) ? child.status : 3;
  let parsed;
  try { parsed = JSON.parse(child.stdout || child.stderr); } catch { /* Never echo raw process output. */ }
  if (action === 'status' && exitCode === 0 && parsed?.checkinAuthorization) {
    reply(parsed, 0);
  } else {
    const allowed = new Set(['authorization_available','already_running','need_authorization','need_login','error','unknown']);
    const result = allowed.has(parsed?.result) ? parsed.result : 'error';
    const candidate = parsed?.reason || parsed?.message;
    const reason = reasons.has(candidate) ? candidate : inputErrors.get(candidate);
    const out = { result, ...(reason ? {reason} : {}) };
    if (result === 'authorization_available') out.serverVerified = false;
    if (reason === 'invalid_checkin_ticket' || reason === 'invalid_authorization_url')
      out.message = '没有收到有效票据。请复制学校入口的完整 URL，并把 SSH 的输入选为“获取剪贴板”的结果。';
    else if (reason === 'ticket_input_timeout') out.message = '读取输入超时，请检查 SSH 的输入是否选择了剪贴板。';
    else if (result === 'already_running') out.message = '账号正被后台任务使用，请稍后再导入。';
    reply(out, result === 'authorization_available' && exitCode === 0 ? 0 : exitCode || 3);
  }
} catch (error) {
  const reason = inputErrors.get(error?.message);
  reply({result:'error',reason:reason || 'iphone_command_denied',
    message: reason ? '未能读取有效输入，请检查 SSH 的输入是否选择了剪贴板。'
      : '此手机密钥仅允许给已绑定账号运行 goodnight-authorize 或 goodnight-status'}, 3);
}
