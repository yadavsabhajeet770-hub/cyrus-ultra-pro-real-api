import {
  WingoDrawItem,
  PredictionSize,
  PredictionColor,
  StrategyResult,
  NumberDetail,
} from '../types';
import { PATTERN_LIBRARY, HISTORICAL_NGRAMS, FAMILY_STATS } from './wingoAdvancedPatternData';

/**
 * SERVER 2 · CYRUS PATTERNS™ ADVANCED PATTERN FUSION
 *
 * Decision engine only. UI/UX is intentionally untouched.
 *
 * The engine combines:
 *  1) live n-gram evidence (3..9)
 *  2) embedded historical n-gram evidence from WingoPatterns_export (24)
 *  3) 500 named structural patterns from "wingo patterns.txt"
 *  4) fuzzy structural/family matching
 *  5) transition + streak + recent-window regime
 *  6) digit-transition and digit-frequency layers
 *
 * SKIP is deliberately rare: it is used only when the combined directional
 * edge is genuinely tiny and no structural/history layer can rescue it.
 */

const BIG: PredictionSize = 'BIG';
const SMALL: PredictionSize = 'SMALL';
const GREEN: PredictionColor = 'GREEN';
const RED: PredictionColor = 'RED';

const BIG_NUMS = [5, 6, 7, 8, 9];
const SMALL_NUMS = [0, 1, 2, 3, 4];
const GREEN_NUMS = [1, 3, 5, 7, 9];
const RED_NUMS = [0, 2, 4, 6, 8];

const clamp = (n:number, lo:number, hi:number) => Math.max(lo, Math.min(hi,n));
const pct = (b:number,s:number) => (b+s ? 100*b/(b+s) : 50);
const sizeOf = (n:number):PredictionSize => n >= 5 ? BIG : SMALL;
const colorOf = (n:number):PredictionColor => {
  if (n===0 || n===5) return 'VIOLET';
  return GREEN_NUMS.includes(n) ? GREEN : RED;
};
const keyOf = (a:PredictionSize[]) => a.map(x=>x===BIG?'B':'S').join('');
const betaPct = (b:number,s:number,prior=1.0) => 100*(b+50*prior)/(b+s+100*prior);

function recency(age:number, halfLife:number) {
  return Math.pow(0.5, Math.max(0,age)/halfLife);
}

interface Vote {
  p:number;
  support:number;
  label:string;
  quality:number;
}

function statForSequence(seq:string, chrono:PredictionSize[], halfLife=120) {
  let b=0,s=0,wb=0,ws=0;
  for(let i=seq.length;i<chrono.length;i++){
    const k=keyOf(chrono.slice(i-seq.length,i));
    if(k!==seq) continue;
    const w=recency(chrono.length-i,halfLife);
    if(chrono[i]===BIG){b++;wb+=w}else{s++;ws+=w}
  }
  return {b,s,wb,ws,total:b+s};
}

function liveNgramVote(chrono:PredictionSize[], maxLen=9):Vote {
  let wb=0,ws=0,total=0;
  const labels:string[]=[];
  for(let L=maxLen;L>=3;L--){
    if(chrono.length<L+1) continue;
    const target=keyOf(chrono.slice(-L));
    const st=statForSequence(target,chrono,110);
    if(!st.total) continue;
    const shrink=Math.min(1, st.total/10);
    const w=(0.55+L/12)*shrink;
    wb += st.wb*w; ws += st.ws*w; total += st.total;
    if(labels.length<2) labels.push(`${L}-step ${target} (${st.total})`);
  }
  return {p:pct(wb,ws),support:total,label:labels.join(' + ')||'No live suffix match',quality:clamp(total/40,0,1)};
}

function embeddedNgramVote(chrono:PredictionSize[]):Vote {
  const current=keyOf(chrono.slice(-9));
  let wb=0,ws=0,total=0;
  const labels:string[]=[];
  for(let L=9;L>=3;L--){
    const target=current.slice(-L);
    const pair=HISTORICAL_NGRAMS[String(L)]?.[target];
    if(!pair) continue;
    const [b,s]=pair;
    const shrink=Math.min(1,(b+s)/24);
    const w=(0.4+L/12)*shrink;
    wb+=b*w; ws+=s*w; total+=b+s;
    if(labels.length<2) labels.push(`${L}-step DB ${target} (${b+s})`);
  }
  return {p:betaPct(wb,ws,0.6),support:total,label:labels.join(' + ')||'No embedded suffix match',quality:clamp(total/150,0,1)};
}

function familyVote(chrono:PredictionSize[]):Vote {
  if(chrono.length<8) return {p:50,support:0,label:'Pattern family unavailable',quality:0};
  const target=keyOf(chrono.slice(-12));
  const scored:{family:string,score:number,depth:number,seq:string}[]=[];
  for(const p of PATTERN_LIBRARY){
    const L=p.seq.length;
    if(L>target.length) continue;
    const suffix=target.slice(-L);
    let dist=0;
    for(let i=0;i<L;i++) if(suffix[i]!==p.seq[i]) dist++;
    const norm=dist/L;
    // Exact and near-exact structures dominate.
    const score=(1-norm)*(L/12);
    if(score>=0.54) scored.push({family:p.family,score,depth:L,seq:p.seq});
  }
  scored.sort((a,b)=>b.score-a.score);
  const top=scored.slice(0,12);
  const agg=new Map<string,number>();
  for(const x of top) agg.set(x.family,(agg.get(x.family)||0)+x.score);
  let wb=0,ws=0,support=0;
  const families:string[]=[];
  for(const [fam,weight] of [...agg.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)){
    const [b,s]=FAMILY_STATS[fam]||[0,0];
    if(b+s<8) continue;
    wb += b*weight; ws += s*weight; support += b+s;
    if(families.length<3) families.push(`${fam} ${(weight*100).toFixed(0)}%`);
  }
  return {p:betaPct(wb,ws,0.7),support,label:families.length?`Families: ${families.join(', ')}`:'No strong structural family',quality:clamp(support/250,0,1)};
}

function transitionVote(chrono:PredictionSize[]):Vote {
  const last=chrono.at(-1);
  if(!last) return {p:50,support:0,label:'No transition',quality:0};
  let same=0,flip=0;
  for(let i=0;i<chrono.length-1;i++){
    if(chrono[i]!==last) continue;
    if(chrono[i+1]===last)same++; else flip++;
  }
  return {p:betaPct(same,flip,0.8),support:same+flip,label:`Transition after ${last}: same ${same} / flip ${flip}`,quality:clamp((same+flip)/35,0,1)};
}

function recentVote(chrono:PredictionSize[]):Vote {
  const windows=[5,10,20,50,100];
  let sum=0,wSum=0;
  for(const n of windows){
    if(chrono.length<n) continue;
    const a=chrono.slice(-n), b=a.filter(x=>x===BIG).length, s=n-b;
    const p=betaPct(b,s,1.5);
    const w=n<=10?1.5:n<=20?1.2:n<=50?0.8:0.45;
    sum+=p*w; wSum+=w;
  }
  return {p:wSum?sum/wSum:50,support:Math.min(100,chrono.length),label:'Recent multi-window regime',quality:chrono.length>=20?1:0.5};
}

function streakVote(chrono:PredictionSize[]):Vote {
  const last=chrono.at(-1)!;
  let streak=0;
  for(let i=chrono.length-1;i>=0&&chrono[i]===last;i--) streak++;
  let same=0,flip=0;
  for(let i=0;i<chrono.length-1;i++){
    if(chrono[i]!==last) continue;
    let j=i;
    while(j+1<chrono.length&&chrono[j+1]===last) j++;
    const len=j-i+1;
    if(len!==streak||j+1>=chrono.length) continue;
    if(chrono[j+1]===last)same++;else flip++;
  }
  // If there are no same-length historical examples, do not invent reversal.
  const p= same+flip ? betaPct(same,flip,0.7) : 50;
  return {p,support:same+flip,label:`Current ${last} streak = ${streak}`,quality:clamp((same+flip)/12,0,1)};
}

function digitVote(digits:number[], target:PredictionSize) {
  const candidates=target===BIG?BIG_NUMS:SMALL_NUMS;
  const last=digits.at(-1);
  const counts=new Map<number,number>(candidates.map(n=>[n,0]));
  let support=0;
  for(let i=0;i<digits.length-1;i++){
    if(digits[i]!==last) continue;
    support++;
    const n=digits[i+1];
    if(counts.has(n)) counts.set(n,(counts.get(n)||0)+1);
  }
  // Add a short suffix model.
  const pair=digits.slice(-2).join('');
  const suffix=new Map<number,number>(candidates.map(n=>[n,0]));
  let suffixSupport=0;
  for(let i=1;i<digits.length-1;i++){
    if(`${digits[i-1]}${digits[i]}`!==pair) continue;
    suffixSupport++;
    const n=digits[i+1];
    if(suffix.has(n)) suffix.set(n,(suffix.get(n)||0)+1);
  }
  const ranked=candidates.map(n=>({
    n,
    score:0.55*(counts.get(n)||0)/Math.max(1,support)+0.45*(suffix.get(n)||0)/Math.max(1,suffixSupport)
  })).sort((a,b)=>b.score-a.score);
  return {ranked,support,suffixSupport};
}

function structuralStrength(votes:Vote[]) {
  const active=votes.filter(v=>v.quality>0.15);
  if(!active.length) return {agreement:0,spread:100};
  const avg=active.reduce((a,v)=>a+v.p,0)/active.length;
  const spread=Math.max(...active.map(v=>Math.abs(v.p-avg)))*2;
  const agreement=clamp(100-spread*2,0,100);
  return {agreement,spread};
}

export function runAdvancedServer2(
  draws:WingoDrawItem[],
  nextPeriod:string,
  _lossStreak=0,
  _analysis?:unknown,
):StrategyResult {
  const safe=(draws||[]).filter(d=>Number.isFinite(Number(d.number))).slice(0,500);
  if(safe.length<10){
    return {
      pred:BIG,nums:[7],top4Nums:[7],
      numDetails:[{num:7,type:'PRIMARY',label:'Advanced Sniper #7',reason:'Need at least 10 valid draws'}],
      colorPred:GREEN,colorProb:{red:50,green:50,violet:0},
      trendHealth:30,trendStatus:'CAUTION',mode:'SERVER 2 · CYRUS PATTERNS™',
      modeCategory:'ADVANCED_PATTERN_FUSION',confidence:50,bigProb:50,smallProb:50,
      reasoning:'Not enough history yet.',focusTarget:'SKIP',targetCategory:'SIZE',
      targetScores:{big:50,small:50,red:50,green:50},isSkip:true,
      skipReason:'Insufficient history',skipRiskLevel:'ENTROPY_ALERT',detectedPatternName:'INSUFFICIENT_DATA'
    };
  }

  const chrono=safe.slice().reverse();
  const digits=chrono.map(d=>Math.abs(Number(d.number))%10);
  const sizes=digits.map(sizeOf);

  const live=liveNgramVote(sizes);
  const db=embeddedNgramVote(sizes);
  const family=familyVote(sizes);
  const transition=transitionVote(sizes);
  const recent=recentVote(sizes);
  const streak=streakVote(sizes);

  // Main score. Live data is strongest, embedded database is stabilizer,
  // named structural patterns add context, and regime signals prevent blindly
  // following a single streak.
  let score=50;
  const layers=[
    [live,0.29],
    [db,0.22],
    [family,0.18],
    [transition,0.11],
    [recent,0.13],
    [streak,0.07],
  ] as const;

  let used=0;
  for(const [v,w0] of layers){
    const w=w0*Math.max(0.35,v.quality);
    score+=(v.p-50)*w;
    used+=w;
  }
  score=50+(score-50)/Math.max(0.72,used/0.9);
  score=clamp(score,5,95);

  // Very short-term oscillation/chop detector.
  const last20=sizes.slice(-20);
  const flips=last20.slice(1).filter((x,i)=>x!==last20[i]).length;
  const flipRate=last20.length>1?flips/(last20.length-1):0.5;
  const b20=last20.filter(x=>x===BIG).length;
  const entropyB=b20/Math.max(1,last20.length);
  const entropy=entropyB===0||entropyB===1?0:-(entropyB*Math.log2(entropyB)+(1-entropyB)*Math.log2(1-entropyB));

  const strength=structuralStrength([live,db,family,transition,recent,streak]);
  const edge=Math.abs(score-50);

  // SKIP only for genuinely flat/contradictory conditions. A disagreement
  // alone is not enough to suppress a prediction.
  const noEvidence=live.support+db.support+family.support<25;
  const severeChop=entropy>0.995 && flipRate>0.68 && edge<3.0;
  const flat=edge<2.25 && strength.agreement<32 && noEvidence;
  const shouldSkip=severeChop||flat;

  const pred:PredictionSize=score>=50?BIG:SMALL;
  const confidence=shouldSkip?50:clamp(50+edge*0.92,53,82);
  const bigProb=pred===BIG?confidence:100-confidence;
  const smallProb=pred===SMALL?confidence:100-confidence;

  const nums=digitVote(digits,pred);
  const top4=nums.ranked.slice(0,4).map(x=>x.n);
  const primary=top4[0] ?? (pred===BIG?7:2);
  const color=colorOf(primary);

  const exactKey=keyOf(sizes.slice(-9));
  const exactPair=HISTORICAL_NGRAMS['9']?.[exactKey];
  const exactLabel=exactPair?`9-step ${exactKey}: ${exactPair[0]}B/${exactPair[1]}S`:`9-step ${exactKey}: no DB match`;

  const reasons=[
    exactLabel,
    live.label,
    db.label,
    family.label,
    transition.label,
    streak.label,
    `recent ${recent.p.toFixed(1)}% B`,
    `edge ${edge.toFixed(1)}%`,
  ];

  const skipReason=shouldSkip
    ? severeChop?'Extreme alternating/chop regime with almost no directional edge.'
    :'Combined pattern evidence is essentially 50/50; prediction would be noise.'
    :'';

  return {
    pred,nums:[primary],top4Nums:top4,
    numDetails:top4.map((n,i)=>({
      num:n,type:i===0?'PRIMARY':'HEDGE',
      label:i===0?`Advanced Sniper #${n}`:`Backup #${n}`,
      reason:`Digit ensemble · last-digit support ${nums.support} · 2-digit support ${nums.suffixSupport}`
    })),
    colorPred:color,
    colorProb:{
      red:color===RED?70:color==='VIOLET'?30:30,
      green:color===GREEN?70:color==='VIOLET'?30:30,
      violet:primary===0||primary===5?20:0
    },
    trendHealth:shouldSkip?46:clamp(52+edge*1.2,55,90),
    trendStatus:shouldSkip?'CAUTION':confidence>=70?'SOLID':confidence>=60?'HEALTHY':'CAUTION',
    mode:'SERVER 2 · CYRUS PATTERNS™',
    modeCategory:'ADVANCED_PATTERN_FUSION',
    baseWinRate:confidence,
    confidenceMetrics:{
      momentum:clamp(50+Math.abs(recent.p-50),50,85),
      volatility:clamp(entropy*100,0,100),
      volume:clamp(safe.length/5,20,100)
    },
    confidence,bigProb,smallProb,
    reasoning:`Server 2 Advanced Pattern Fusion · ${shouldSkip?'SKIP':pred} · ${reasons.join(' · ')}`,
    focusTarget:shouldSkip?'SKIP':pred,targetCategory:'SIZE',
    targetScores:{big:bigProb,small:smallProb,red:color===RED?70:30,green:color===GREEN?70:30},
    isSkip:shouldSkip,skipReason,skipRiskLevel:shouldSkip?'ENTROPY_ALERT':undefined,
    detectedPatternName:shouldSkip?`⚠️ ${skipReason}`:`${family.label} · ${exactKey}`,
    databasePatternDisplay:`${exactKey} → ${exactPair?`${exactPair[0]}B/${exactPair[1]}S`:'live/structural ensemble'}`,
    databasePatternSignal:pred===BIG?'1':'2',
  };
}
