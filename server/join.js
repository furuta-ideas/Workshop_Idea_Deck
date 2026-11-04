import {randomBytes,randomInt} from 'node:crypto';
import {id,hash,normalizeEmail} from './store.js';
import {requireThat,access,expiry} from './domain.js';
import {rateLimit} from './auth.js';
export class Join {
  constructor(store,auth,config,notion){Object.assign(this,{store,auth,config,notion});}
  workshop(wsId){
    const ws=this.store.get('workshops',wsId);
    requireThat(ws && !ws.deleted && ws.status==='進行中' && expiry(ws.endDate)>Date.now(),'このワークショップへの参加受付は終了しています',403);
    return ws;
  }
  requestKey(wsId,email){return `join-request:${wsId}:${hash(email)}`;}
  async start(body,ip){
    requireThat(!this.config.demo && this.auth.emailOtpReady(),'メールOTPの送信設定がありません',503);
    const ws=this.workshop(body.workshopId),email=normalizeEmail(body.email);
    requireThat(email.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'メールアドレスを確認してください');
    requireThat(!this.store.get('users',email)?.disabled,'このアカウントは参加できません',403);
    rateLimit(this.store,`join-ip:${ip}`,20,600000);rateLimit(this.store,`otp:${email}`,4,600000);
    const challenge=id(),code=String(randomInt(100000,1000000));
    this.store.put('challenges',challenge,{type:'join-otp',email,wsId:ws.id,digest:hash(`${challenge}:${code}`),attempts:0,expires:Date.now()+600000});
    try{await this.auth.sendOtp(email,code);}catch(error){this.store.del('challenges',challenge);throw error;}
    return {challenge,workshop:ws.name,message:'メールに認証コードを送りました。'};
  }
  verify(body,res){
    const c=this.store.get('challenges',body.challenge);
    requireThat(c?.type==='join-otp' && c.expires>Date.now() && c.attempts<5,'認証コードが無効または期限切れです',401);
    c.attempts++;this.store.put('challenges',body.challenge,c);
    requireThat(c.digest===hash(`${body.challenge}:${String(body.code)}`),'認証コードを確認してください',401);
    this.store.del('challenges',body.challenge);
    const ws=this.workshop(c.wsId);
    requireThat(!this.store.get('users',c.email)?.disabled,'アカウントが無効です',403);
    const existing=this.store.get('kv',this.requestKey(ws.id,c.email));
    this.store.put('kv',this.requestKey(ws.id,c.email),{id:hash(c.email),wsId:ws.id,email:c.email,verifiedAt:Date.now(),status:ws.members[c.email]?'approved':existing?.status==='approved'?'approved':'pending'});
    const token=randomBytes(32).toString('base64url');
    this.store.put('challenges',hash(token),{type:'join-ticket',email:c.email,wsId:ws.id,expires:Date.now()+12*3600000});
    res.setHeader('Set-Cookie',`wid_join=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${this.config.secure?'; Secure':''}`);
    return {status:'verified',workshop:ws.name};
  }
  status(req,res){
    const token=/(?:^|;\s*)wid_join=([^;]+)/.exec(req.headers.cookie || '')?.[1],ticket=token && this.store.get('challenges',hash(token));
    requireThat(ticket?.type==='join-ticket' && ticket.expires>Date.now(),'参加ページからメール認証をやり直してください',401);
    const ws=this.workshop(ticket.wsId),request=this.store.get('kv',this.requestKey(ws.id,ticket.email));
    if(request?.status==='rejected')return {status:'rejected',workshop:ws.name};
    if(request?.status!=='approved' || !ws.members[ticket.email])return {status:'pending',workshop:ws.name};
    const account=this.store.get('users',ticket.email);
    requireThat(account && !account.disabled,'アカウントが無効です',403);
    access(this.store,ws,{...account,admin:false});
    this.store.del('challenges',hash(token));
    return {status:'approved',workshopId:ws.id,...this.auth.session(ticket.email,res)};
  }
  pending(ws,user){
    requireThat(user.admin,'管理者のみ操作できます',403);access(this.store,ws,user);
    return this.store.db.prepare('SELECT body FROM kv WHERE id LIKE ?').all(`join-request:${ws.id}:%`).map(r=>JSON.parse(r.body)).filter(r=>r.status==='pending');
  }
  async decide(ws,user,body){
    requireThat(user.admin,'管理者のみ操作できます',403);access(this.store,ws,user,true);
    const email=normalizeEmail(body.email),key=this.requestKey(ws.id,email),r=this.store.get('kv',key);
    requireThat(r?.status==='pending' && r.verifiedAt,'メール認証済みの申請がありません',409);
    requireThat(['approve','reject'].includes(body.decision),'承認操作が不正です');
    if(body.decision==='approve'){
      requireThat(ws.teams[body.teamId],'参加先のチームを選択してください');
      const member={role:'編集者',teamId:body.teamId};
      if(ws.notion)await this.notion.setMember(ws,email,member);
      else {const latest=this.store.get('workshops',ws.id);latest.members[email]=member;latest.revision++;this.store.put('workshops',ws.id,latest);}
      const account=this.store.get('users',email)||{id:id(),email,admin:false,passkeys:[]};
      requireThat(!account.disabled,'アカウントが無効です',403);this.store.put('users',email,account);
    }
    r.status=body.decision==='approve'?'approved':'rejected';r.decidedAt=Date.now();this.store.put('kv',key,r);
    this.store.audit('join-decision',{wsId:ws.id,decision:r.status,actor:hash(user.email),participant:hash(email)});
    return {ok:true};
  }
}
