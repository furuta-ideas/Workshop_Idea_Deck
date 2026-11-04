import { id,hash,newTeam } from './store.js';
import {requireThat,text} from './domain.js';
import {deckSlots} from './deck.js';
export const ideaImageKey=(wsId,key)=>`idea-image:${wsId}:${key}`;
export function ideaById(ws,ideaId){for(const team of Object.values(ws.teams)){const idea=team.ideas?.find(i=>i.id===ideaId);if(idea)return {team,idea};}return null;}
export function markIdeaDraft(team){
  if(!team.pendingDiscussion){team.publishedDiscussion=structuredClone(team.discussion);team.publishedImageKey=team.image?hash(team.image.base64):null;}
  team.pendingDiscussion=true;
}
export function patchDiscussion(team,p){
  for(const [key,max] of Object.entries({transcript:30000,headline:100,who:40,what:40,how:120,points:5000,keywords:500,pressRelease:2000}))if(p[key]!==undefined)team.discussion[key]=text(p[key],max);
  if(p.features!==undefined){requireThat(Array.isArray(p.features)&&p.features.length<=3,'特長は３つまでです');team.discussion.features=p.features.map(v=>{const line=text(v,200);requireThat(!/[\r\n]/.test(line),'特長は１行ずつです');return line;});}
}
// A deck is worth keeping when it has cards, discussion text or an image.
export function hasDeckContent(team){return !!(team.deck.length || team.image || ['headline','what','who','how','transcript','pressRelease','points'].some(k=>team.discussion[k]?.trim()) || team.discussion.features?.some(Boolean));}
export function saveIdea(store,ws,team,p={}){
  patchDiscussion(team,p);
  const title=team.discussion.headline || team.discussion.what || 'アイデア '+((team.ideas?.length || 0)+1);
  requireThat(team.deck.length || Object.values(team.discussion).some(v=>typeof v==='string'&&v.trim()) || team.image,'記録する内容を入力してください');
  team.ideas ||= [];
  let idea=team.ideas.find(i=>i.id===team.activeIdeaId);
  requireThat(idea || team.ideas.length<100,'保存できる企画はチームごとに100件までです');
  const now=new Date().toISOString();
  if(!idea){idea={id:id(),createdAt:now,revision:0};team.ideas.push(idea);}
  const cards=team.deck.map(cardId=>team.nodes.find(n=>n.id===cardId)||team.restoredCards?.find(n=>n.id===cardId)).filter(Boolean).map(({id,text,group})=>({id,text,group}));
  let image=null;
  if(team.image){const key=hash(team.image.base64);store.put('kv',ideaImageKey(ws.id,key),team.image);image={key,width:team.image.width,height:team.image.height};}
  Object.assign(idea,{title,updatedAt:now,revision:idea.revision+1,deck:[...team.deck],deckSlots:deckSlots(team),cards,discussion:structuredClone(team.discussion),image});
  team.activeIdeaId=idea.id;team.pendingDiscussion=false;team.publishedDiscussion=structuredClone(team.discussion);team.publishedImageKey=image?.key || null;
  return idea;
}
export function clearIdea(store,ws,team,p={}){
  patchDiscussion(team,p);
  if(hasDeckContent(team))saveIdea(store,ws,team);
  team.deck=[];team.deckSlots=Array(5).fill(null);team.discussion=newTeam('').discussion;team.image=null;team.activeIdeaId=null;team.restoredCards=[];team.pendingDiscussion=false;
}
export function restoreIdea(store,ws,team,idea){
  if(team.activeIdeaId!==idea.id && hasDeckContent(team)) saveIdea(store,ws,team);
  team.deck=[...idea.deck];team.deckSlots=[...idea.deckSlots];team.restoredCards=structuredClone(idea.cards);team.discussion=structuredClone(idea.discussion);team.activeIdeaId=idea.id;
  team.image=idea.image?store.get('kv',ideaImageKey(ws.id,idea.image.key)) || null:null;
  team.pendingDiscussion=false;
}
