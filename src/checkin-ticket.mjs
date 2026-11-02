import crypto from 'node:crypto';

const ORIGIN = 'https://jzsz.uestc.edu.cn';
const PAGE_PATH = '/daily-checkin-h5/index.html';
const FILE = 'checkin-ticket.json';
export const CHECKIN_AUTH_CODES = new Set([46001, 46002, 46003]);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validTicket = value => typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value);

export class CheckinAuthorizationError extends Error {
  constructor(reason) { super(reason); this.code = 'need_authorization'; this.reason = reason; }
}
const fail = reason => { throw new CheckinAuthorizationError(reason); };
function schoolPage(value) {
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && url.pathname === PAGE_PATH && !url.username && !url.password;
  } catch { return false; }
}

// An owner may supply the opaque ticket or the school's authorized entry URL.
// Never send this input to another URL or print it in diagnostics.
export function parseTicketInput(input) {
  if (typeof input !== 'string' || input.length > 32768) fail('invalid_checkin_ticket');
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    if (!schoolPage(value)) fail('invalid_authorization_url');
    const url = new URL(value), queryAt = url.hash.indexOf('?');
    const values = [...url.searchParams.getAll('checkinTicket'),
      ...new URLSearchParams(queryAt < 0 ? '' : url.hash.slice(queryAt + 1)).getAll('checkinTicket')];
    if (!values.length || values.some(item => !validTicket(item)) || new Set(values).size !== 1) fail('invalid_checkin_ticket');
    return values[0];
  }
  if (!validTicket(value)) fail('invalid_checkin_ticket');
  return value;
}

export function checkinTicketStatus(store) {
  try {
    const record = store.read(FILE);
    if (!record) return { state: 'missing' };
    if (record.version !== 1 || !['available', 'rejected'].includes(record.state)) return { state: 'unreadable' };
    const identity = store.read('identity.json');
    if (identity && identity.hash !== record.identityHash) return { state: 'identity_mismatch' };
    if (record.state === 'available' && !validTicket(record.ticket)) return { state: 'unreadable' };
    // Presence is not proof of current server-side validity or future renewal.
    return { state: record.state, serverVerified: false,
      ...(typeof record.savedAt === 'string' ? { savedAt: record.savedAt } : {}),
      ...(CHECKIN_AUTH_CODES.has(record.code) ? { code: record.code } : {}) };
  } catch { return { state: 'unreadable' }; }
}

// Tickets come only from an explicit owner import. The server browser never
// opens the mini-program entry URL, so it has no ticket to read.
export function createCheckinTicketManager(store) {
  let identityHash, activeTicket;
  const read = () => {
    try { return store?.read(FILE); }
    catch { fail('checkin_ticket_unreadable'); }
  };
  const requireIdentity = () => { if (!identityHash) fail('checkin_identity_unavailable'); };
  return {
    bindIdentity(userId) {
      identityHash = typeof userId === 'string' && userId.trim() ? hash('uestc-user:' + userId) : null;
      activeTicket = undefined;
    },
    import(input) {
      requireIdentity();
      const ticket = parseTicketInput(input), prior = read();
      if (prior?.state === 'rejected' && prior.fingerprint === hash(ticket)) fail('checkin_ticket_rejected');
      store?.write(FILE, { version: 1, identityHash, ticket, source: 'imported', state: 'available', savedAt: new Date().toISOString() });
      activeTicket = ticket;
      return { result: 'authorization_available', serverVerified: false };
    },
    async require() {
      requireIdentity();
      if (activeTicket) return activeTicket;
      const prior = read();
      if (!prior) fail('checkin_ticket_missing');
      if (prior.version !== 1 || !['available', 'rejected'].includes(prior.state)) fail('checkin_ticket_unreadable');
      if (prior.identityHash !== identityHash) fail('checkin_ticket_identity_mismatch');
      if (prior.state === 'rejected') fail('checkin_ticket_rejected');
      if (!validTicket(prior.ticket)) fail('invalid_checkin_ticket');
      return activeTicket = prior.ticket;
    },
    reject(code) {
      if (!CHECKIN_AUTH_CODES.has(code) || !activeTicket) return;
      const rejected = activeTicket;
      activeTicket = undefined;
      // Retain only a fingerprint so the same rejected ticket cannot be imported again.
      store?.write(FILE, { version: 1, identityHash, state: 'rejected', fingerprint: hash(rejected), code, rejectedAt: new Date().toISOString() });
    },
  };
}
