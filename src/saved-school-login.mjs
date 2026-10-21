import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REALM='https://idas.uestc.edu.cn/';
const READ_LOGIN=`
import sqlite3,json,base64,sys
con=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
rows=con.execute('SELECT username_value,password_value FROM logins WHERE signon_realm=? AND blacklisted_by_user=0 AND username_value<>? AND length(password_value)>0',(sys.argv[2],'')).fetchall()
if len(rows)==1:
 print(json.dumps({'username':rows[0][0],'encrypted':base64.b64encode(rows[0][1]).decode()}))
else:
 print('null')
con.close()
`;

// Read only this application's school login, never export the password database.
// Linux v10 compatibility follows Chromium components/os_crypt/os_crypt_linux.cc.
// Other keyring formats are deliberately unsupported.
export function readSavedSchoolLogin(dataDir) {
  if(process.platform!=='linux')return null;
  const file=path.join(dataDir,'profile','Default','Login Data');
  let key,plain,output;
  try {
    const stat=fs.statSync(file);
    if(!stat.isFile()||stat.uid!==process.getuid())return null;
    output=execFileSync('python3',['-c',READ_LOGIN,file,REALM],{
      encoding:'utf8',timeout:5000,maxBuffer:65536,stdio:['ignore','pipe','pipe'],
    });
    const row=JSON.parse(output);output=null;
    if(!row||typeof row.username!=='string'||!row.username||row.username.length>512||typeof row.encrypted!=='string')return null;
    const encrypted=Buffer.from(row.encrypted,'base64');
    if(encrypted.subarray(0,3).toString()!=='v10'||encrypted.length<19||encrypted.length>8192)return null;
    key=crypto.pbkdf2Sync('peanuts','saltysalt',1,16,'sha1');
    const decipher=crypto.createDecipheriv('aes-128-cbc',key,Buffer.alloc(16,32));
    plain=Buffer.concat([decipher.update(encrypted.subarray(3)),decipher.final()]);
    const password=new TextDecoder('utf8',{fatal:true}).decode(plain);
    if(!password||password.includes('\0')||password.length>4096)return null;
    return {username:row.username,password};
  }catch{
    // Exceptions from child processes can contain private stdout: never propagate them.
    return null;
  }finally{
    key?.fill(0);plain?.fill(0);output=null;
  }
}
