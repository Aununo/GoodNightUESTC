import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readSavedSchoolLogin } from '../src/saved-school-login.mjs';

function encrypted(value,prefix='v10') {
  const key=crypto.pbkdf2Sync('peanuts','saltysalt',1,16,'sha1');
  const cipher=crypto.createCipheriv('aes-128-cbc',key,Buffer.alloc(16,32));
  return Buffer.concat([Buffer.from(prefix),cipher.update(value),cipher.final()]).toString('base64');
}
function fixture(t,rows) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'goodnight-school-vault-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'profile','Default'),{recursive:true});
  const file=path.join(dir,'profile','Default','Login Data');
  execFileSync('python3',['-c',`
import sqlite3,json,sys,base64
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE logins(signon_realm TEXT,username_value TEXT,password_value BLOB,blacklisted_by_user INTEGER)')
for r in json.loads(sys.stdin.read()):
 c.execute('INSERT INTO logins VALUES(?,?,?,?)',(r['realm'],r['username'],base64.b64decode(r['encrypted']),r.get('blocked',0)))
c.commit();c.close()
`,file],{input:JSON.stringify(rows),stdio:['pipe','pipe','pipe']});
  return dir;
}
test('saved school login reads only the exact allowed school realm', {skip:process.platform!=='linux'},t=>{
  const dir=fixture(t,[
    {realm:'https://other.example/',username:'unrelated-account',encrypted:encrypted('unrelated-secret')},
    {realm:'https://idas.uestc.edu.cn/',username:'synthetic-school-user',encrypted:encrypted('synthetic-school-secret')},
  ]);
  assert.deepEqual(readSavedSchoolLogin(dir),{username:'synthetic-school-user',password:'synthetic-school-secret'});
});
test('ambiguous accounts and unsupported encryption require manual login', {skip:process.platform!=='linux'},t=>{
  const row={realm:'https://idas.uestc.edu.cn/',username:'synthetic-user',encrypted:encrypted('synthetic-secret')};
  assert.equal(readSavedSchoolLogin(fixture(t,[row,{...row,username:'another-user'}])),null);
  assert.equal(readSavedSchoolLogin(fixture(t,[{...row,encrypted:encrypted('synthetic-secret','v11')}])),null);
  assert.equal(readSavedSchoolLogin(fixture(t,[{...row,blocked:1}])),null);
});
