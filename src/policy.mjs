export const apiSucceeded = r => r?.code === 0 && r.ok !== false;
export const shanghaiDate = (now = new Date()) => now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
export function summary(r) { return { code:r?.code, businessDate:r?.data?.businessDate, status:r?.data?.recordStatusCode }; }
const TERMINAL = new Set(['STUDENT_REPORTED','INSTRUCTOR_REPORTED','CHECKED_IN','EXEMPT']);
export function todayState(r, now = new Date()) {
 if (!apiSucceeded(r) || r.data?.businessDate !== shanghaiDate(now)) return 'unknown';
 if(r.data.recordStatusCode==='PENDING')return 'pending';
 return TERMINAL.has(r.data.recordStatusCode)?'done':'unknown';
}
export function checkinWindow(schedule,date,now=new Date()) {
 const d=schedule?.data;
 if(!apiSucceeded(schedule)||date!==shanghaiDate(now)||!Number.isFinite(d?.studentCheckinStartOffsetMinute)||!Number.isFinite(d?.studentCheckinEndOffsetMinute))return {result:'window_missed',reason:'invalid_schedule'};
 const midnight=Date.parse(`${date}T00:00:00+08:00`),start=midnight+d.studentCheckinStartOffsetMinute*60000,end=Math.min(midnight+d.studentCheckinEndOffsetMinute*60000,midnight+86400000)-300000;
 if(start<midnight||start>=end)return {result:'window_missed',reason:'invalid_schedule'};
 if(now.getTime()<start)return {result:'window_not_open',businessDate:date,nextAttemptAt:new Date(start).toISOString()};
 return now.getTime()<end?{result:'open',businessDate:date}:{result:'window_missed',reason:'checkin_window_ended'};
}
export function checkinVerified(r,date) {return apiSucceeded(r)&&r.data?.businessDate===date&&r.data.recordStatusCode==='CHECKED_IN';}
export function findDorm(geo,response) {
 if(!apiSucceeded(response)||!Array.isArray(response.data))throw new Error('dorm_fences_unavailable');
 if(![geo?.latitude,geo?.longitude].every(Number.isFinite)||Math.abs(geo.latitude)>90||Math.abs(geo.longitude)>180)throw new Error('invalid_location');
 const toRad=x=>x*Math.PI/180;
 return response.data.map(f=>{
  if(![f.latitude,f.longitude,f.radiusMeter].every(Number.isFinite)||Math.abs(f.latitude)>90||Math.abs(f.longitude)>180||f.radiusMeter<=0)throw new Error('invalid_dorm_fence');
  const dlat=toRad(geo.latitude-f.latitude),dlon=toRad(geo.longitude-f.longitude);
  const hav=Math.sin(dlat/2)**2+Math.cos(toRad(geo.latitude))*Math.cos(toRad(f.latitude))*Math.sin(dlon/2)**2;
  return {f,inside:2*Math.asin(Math.sqrt(Math.min(1,hav)))*6378137<=f.radiusMeter};
 }).find(x=>x.inside)?.f||null;
}
