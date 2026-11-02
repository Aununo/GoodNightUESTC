// Secrets arrive as stdin data, never shell text, argv, or diagnostic output.
export function readTicketStdin(stream, { maxBytes = 32768, timeoutMs = 15000 } = {}) {
  if (stream.isTTY) return Promise.reject(new Error('票据标准输入需通过管道或 SSH 输入传入，不能在回显终端中输入'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      stream.pause();
      if (error) reject(new Error(error));
      else resolve(Buffer.concat(chunks).toString('utf8'));
      chunks.length = 0;
    };
    const onData = chunk => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > maxBytes) finish('票据输入超过 32 KiB 限制');
      else chunks.push(data);
    };
    const onEnd = () => finish();
    const onError = () => finish('无法读取票据标准输入');
    const onClose = () => finish('票据标准输入意外关闭');
    const timer = setTimeout(() => finish('读取票据输入超时；请检查快捷指令是否传入剪贴板'), timeoutMs);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
    if (stream.readableEnded) onEnd();
    else if (stream.destroyed) onClose();
  });
}
