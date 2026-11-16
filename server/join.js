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
  // The workshop's 6-digit number, shown on the join screen and typed by guests.
  code(ws){
    if(/^\d{6}$/.test(ws.joinCode||''))return ws.joinCode;
    const taken=new Set(this.store.all('workshops').map(w=>w.joinCode));
    let code;
    do code=String(randomInt(100000,1000000)); while(taken.has(code));
    const latest=this.store.get('workshops',ws.id);latest.joinCode=code;this.store.put('workshops',ws.id,latest);
    ws.joinCode=code;
    return code;
  }
  byCode(code){
    const found=/^\d{6}$/.test(String(code||''))&&this.store.all('workshops').find(w=>w.joinCode===String(code));
    requireThat(found,'ワークショップの番号を確認してください',403);
    return found.id;
  }
  // The emailed code is 2 digits for a guest. An admin's address keeps the 6-digit code and
  // gets its ordinary (admin) login.
  shortCode(ws,email){
    const account=this.store.get('users',email);
    if(account?.admin||email===normalizeEmail(this.config.adminEmail||''))return false;
    if(ws.members[email]?.role==='管理者')return false;
    // v0.30: also for an address known from other workshops. The session a 2-digit code
    // gives is for this workshop only and never has admin rights, so it opens nothing else.
    return true;
  }
  async start(body,ip){
    requireThat(!this.config.demo && this.auth.emailOtpReady(),'メールOTPの送信設定がありません',503);
    rateLimit(this.store,`join-ip:${ip}`,300,600000);
    const ws=this.workshop(body.code!==undefined?this.byCode(body.code):body.workshopId),email=normalizeEmail(body.email);
    requireThat(email.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'メールアドレスを確認してください');
    requireThat(!this.store.get('users',email)?.disabled,'このアカウントは参加できません',403);
    rateLimit(this.store,`otp:${email}`,4,600000);
    const short=this.shortCode(ws,email);
    const challenge=id(),code=short?String(randomInt(10,100)):String(randomInt(100000,1000000));
    this.store.put('challenges',challenge,{type:'join-otp',email,wsId:ws.id,digest:hash(`${challenge}:${code}`),attempts:0,max:short?3:5,expires:Date.now()+600000});
    try{await this.auth.sendOtp(email,code);}catch(error){this.store.del('challenges',challenge);throw error;}
    return {challenge,workshop:ws.name,digits:short?2:6,message:`メールに${short?2:6}桁の認証コードを送りました。`};
  }
  // v0.19: a verified email becomes an editor of the workshop at once (no approval, no team).
  async verify(body,res,remote=(fn)=>fn()){
    const c=this.store.get('challenges',body.challenge);
    requireThat(c?.type==='join-otp' && c.expires>Date.now() && c.attempts<(c.max||5),'認証コードが無効または期限切れです。最初からやり直してください',401);
    c.attempts++;this.store.put('challenges',body.challenge,c);
    requireThat(c.digest===hash(`${body.challenge}:${String(body.code)}`),'認証コードを確認してください',401);
    this.store.del('challenges',body.challenge);
    const ws=this.workshop(c.wsId);
    requireThat(!this.store.get('users',c.email)?.disabled,'アカウントが無効です',403);
    if(!ws.members[c.email]){
      // Registered in the app at once; Notion's list gets the address at the next export,
      // so joining never waits for (or fails with) Notion.
      const member={role:'編集者',teamId:null,local:true};
      const latest=this.store.get('workshops',ws.id);latest.members[c.email]=member;latest.revision++;this.store.put('workshops',ws.id,latest);
    }
    const account=this.store.get('users',c.email)||{id:id(),email:c.email,admin:false,passkeys:[]};
    this.store.put('users',c.email,account);
    this.store.put('kv',this.requestKey(ws.id,c.email),{id:hash(c.email),wsId:ws.id,email:c.email,verifiedAt:Date.now(),status:'approved'});
    this.store.audit('join-auto',{wsId:ws.id,participant:hash(c.email)});
    return {status:'approved',workshopId:ws.id,workshop:ws.name,guest:c.max===3,
      // A guest (2-digit code) gets a session for this workshop only, and no 24-hour pass
      // for the ordinary login.
      ...this.auth.session(c.email,res,c.max===3?{scope:ws.id}:{trust:true})};
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
