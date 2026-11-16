(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const minimap = document.getElementById("minimap");
  const mctx = minimap.getContext("2d");
  const $ = (id) => document.getElementById(id);

  const hud = $("hud"), overlay = $("overlay"), startBtn = $("start-btn");
  const W = 800, H = 500, FOV = Math.PI / 2.8, MAX_DEPTH = 18;
  const map = [
    "1111111111111111",
    "1000000000000001",
    "1000100001000001",
    "1000100001000001",
    "1000000000000001",
    "1000001100000001",
    "1000001100000001",
    "1000000000000001",
    "1001000000010001",
    "1001000000010001",
    "1000000000000001",
    "1000000000000001",
    "1111111111111111"
  ];
  const MW = map[0].length, MH = map.length;
  let screenW = 0, screenH = 0, zBuffer = new Array(W).fill(MAX_DEPTH);
  let running = false, paused = false, gameOver = false;
  let lastTime = 0, elapsed = 0, wave = 1, score = 0, kills = 0;
  let ammo = 12, reloading = false, reloadTimer = 0, shootCooldown = 0;
  let hurtFlash = 0, hitFlash = 0, toastTimer = 0, toastMessage = "";
  let keys = {}, mouseDown = false, audioCtx = null;
  const player = { x: 2.5, y: 2.5, angle: 0.12, health: 100, bob: 0, recoil: 0, moving: false };
  let entities = [], particles = [], projectiles = [];

  function resize() {
    screenW = canvas.width = Math.max(320, Math.floor(innerWidth * Math.min(devicePixelRatio || 1, 1.5)));
    screenH = canvas.height = Math.max(240, Math.floor(innerHeight * Math.min(devicePixelRatio || 1, 1.5)));
  }
  addEventListener("resize", resize); resize();

  function cell(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= MW || iy >= MH) return "1";
    return map[iy][ix];
  }
  function blocked(x, y, r = .18) {
    return cell(x-r,y-r)==="1" || cell(x+r,y-r)==="1" || cell(x-r,y+r)==="1" || cell(x+r,y+r)==="1";
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function normAngle(a) { while (a > Math.PI) a -= Math.PI*2; while (a < -Math.PI) a += Math.PI*2; return a; }
  function distance(a,b) { return Math.hypot(a.x-b.x, a.y-b.y); }

  function beep(freq=440, duration=.06, type="sine", volume=.035) {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = type; osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(volume, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + duration);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(); osc.stop(audioCtx.currentTime + duration);
    } catch (_) {}
  }

  function showToast(message, duration=1.4) {
    toastMessage = message; toastTimer = duration;
    $("toast").textContent = message; $("toast").style.opacity = 1;
  }

  function spawnEntity() {
    let x, y, attempts = 0;
    do {
      x = 1.5 + Math.random() * (MW - 3);
      y = 1.5 + Math.random() * (MH - 3);
      attempts++;
    } while ((blocked(x,y) || Math.hypot(x-player.x,y-player.y)<4) && attempts<100);
    const typeRoll = Math.random();
    const type = typeRoll > .78 ? "brute" : typeRoll > .48 ? "wisp" : "stalker";
    entities.push({
      x,y,type,
      hp: type==="brute" ? 5 : type==="wisp" ? 2 : 3,
      maxHp: type==="brute" ? 5 : type==="wisp" ? 2 : 3,
      speed: type==="brute" ? .48 : type==="wisp" ? 1.12 : .72,
      radius: type==="brute" ? .34 : .23,
      phase: Math.random()*Math.PI*2,
      attack: Math.random()*.6,
      flash: 0,
      alive: true
    });
  }

  function startWave() {
    const count = Math.min(3 + wave*2, 20);
    for (let i=0;i<count;i++) spawnEntity();
    $("wave").textContent = String(wave).padStart(2,"0");
    $("objective").textContent = `CONTAIN ${count} ENTITIES`;
    showToast(`SECTOR ${String(wave).padStart(2,"0")} — INCOMING`);
  }

  function resetGame() {
    player.x=2.5; player.y=2.5; player.angle=.12; player.health=100; player.bob=0; player.recoil=0;
    ammo=12; wave=1; score=0; kills=0; elapsed=0;
    entities=[]; particles=[]; projectiles=[];
    reloading=false; reloadTimer=0; gameOver=false; paused=false;
    updateHud(); startWave();
  }

  function updateHud() {
    $("health").textContent = Math.ceil(player.health);
    $("health-fill").style.width = `${player.health}%`;
    $("ammo").textContent = ammo;
    $("objective").textContent = entities.length ? `THREATS REMAINING: ${entities.length}` : "SECTOR SECURE";
  }

  function raycast(angle) {
    const sin=Math.sin(angle), cos=Math.cos(angle);
    let dist=0, hitX=0, hitY=0, side=0;
    while (dist<MAX_DEPTH) {
      dist += .025;
      hitX=player.x+cos*dist; hitY=player.y+sin*dist;
      if (cell(hitX,hitY)==="1") { side = Math.abs((hitX%1)-.5)>Math.abs((hitY%1)-.5) ? 0 : 1; break; }
    }
    return {dist, hitX, hitY, side};
  }

  function renderWorld() {
    const w=screenW, h=screenH;
    ctx.clearRect(0,0,w,h);
    const horizon=h*.49 + Math.sin(player.bob)*2.2*(player.moving?1:0);
    const sky=ctx.createLinearGradient(0,0,0,horizon);
    sky.addColorStop(0,"#081321"); sky.addColorStop(1,"#1a3545");
    ctx.fillStyle=sky; ctx.fillRect(0,0,w,horizon);
    const floor=ctx.createLinearGradient(0,horizon,0,h);
    floor.addColorStop(0,"#263b43"); floor.addColorStop(1,"#080e16");
    ctx.fillStyle=floor; ctx.fillRect(0,horizon,w,h-horizon);

    // Distant atmospheric lights
    for(let i=0;i<22;i++){
      const x=((i*173 + elapsed*7)%(w+80))-40;
      ctx.fillStyle=`rgba(102,244,232,${.07 + (i%3)*.025})`;
      ctx.fillRect(x, horizon-70-(i%5)*17, 2, 2);
    }

    const step=2;
    for(let sx=0;sx<w;sx+=step) {
      const rayAngle=player.angle + Math.atan((sx-w/2)/(w/2)*Math.tan(FOV/2));
      const hit=raycast(rayAngle);
      const corrected=Math.max(.05,hit.dist*Math.cos(rayAngle-player.angle));
      const wallH=Math.min(h*1.8, h*.82/corrected);
      const top=horizon-wallH/2;
      const texture=(Math.floor(hit.hitX*5)+Math.floor(hit.hitY*5))%2;
      const shade=clamp(1-corrected/13,.12,.9)*(hit.side===1?.78:1);
      const r=Math.floor((texture?30:38)*shade), g=Math.floor((texture?89:111)*shade), b=Math.floor((texture?111:130)*shade);
      ctx.fillStyle=`rgb(${r},${g},${b})`; ctx.fillRect(sx,top,step+1,wallH);
      ctx.fillStyle=`rgba(102,244,232,${shade*.16})`; ctx.fillRect(sx,top,step+1,2);
      if(Math.floor(hit.hitX*2)%5===0) { ctx.fillStyle=`rgba(130,220,225,${shade*.13})`; ctx.fillRect(sx,top+wallH*.35,step+1,1); }
      for(let k=sx;k<Math.min(w,sx+step);k++) zBuffer[k]=corrected;
    }

    renderEntities(w,h,horizon);
    renderProjectiles(w,h,horizon);
    renderWeapon(w,h);
    drawVignette(w,h);
  }

  function project(obj,w,h,horizon) {
    const dx=obj.x-player.x, dy=obj.y-player.y;
    const dist=Math.hypot(dx,dy);
    const angle=normAngle(Math.atan2(dy,dx)-player.angle);
    if(Math.abs(angle)>FOV*.78 || dist<.1) return null;
    const sx=w/2 + Math.tan(angle)/Math.tan(FOV/2)*(w/2);
    const size=clamp(h*.72/dist,2,h*1.2);
    return {sx,size,dist,top:horizon-size*.58};
  }

  function renderEntities(w,h,horizon) {
    const sorted=[...entities].sort((a,b)=>distance(b,player)-distance(a,player));
    for(const e of sorted) {
      const p=project(e,w,h,horizon); if(!p) continue;
      const {sx,size,dist,top}=p;
      if(sx<0||sx>=w) continue;
      const z=zBuffer[clamp(Math.floor(sx),0,w-1)];
      if(dist>z+.35) continue;
      const bob=Math.sin(elapsed*4+e.phase)*size*.035;
      const cx=sx, cy=top+size*.55+bob;
      const core=size*(e.type==="brute"?.33:.25);
      const hue=e.type==="brute"?18:e.type==="wisp"?190:286;
      const glow=ctx.createRadialGradient(cx,cy,core*.2,cx,cy,core*1.9);
      glow.addColorStop(0,`hsla(${hue},100%,70%,.5)`); glow.addColorStop(1,`hsla(${hue},100%,50%,0)`);
      ctx.fillStyle=glow; ctx.beginPath(); ctx.arc(cx,cy,core*1.9,0,Math.PI*2); ctx.fill();

      ctx.save(); ctx.translate(cx,cy);
      const pulse=1+Math.sin(elapsed*5+e.phase)*.07;
      ctx.scale(pulse,1);
      ctx.fillStyle=`hsla(${hue},85%,${e.flash>0?95:47}%,.95)`;
      ctx.strokeStyle=`hsla(${hue},100%,80%,.9)`; ctx.lineWidth=Math.max(1,size*.018);
      if(e.type==="wisp") {
        ctx.beginPath(); ctx.moveTo(0,-core*1.5); ctx.lineTo(core*.9,0); ctx.lineTo(0,core*1.5); ctx.lineTo(-core*.9,0); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle="#e9ffff"; ctx.fillRect(-core*.34,-core*.12,core*.68,core*.18);
      } else {
        ctx.beginPath(); ctx.ellipse(0,0,core*(e.type==="brute"?1.18:.8),core*(e.type==="brute"?1.5:1.2),0,0,Math.PI*2); ctx.fill(); ctx.stroke();
        ctx.fillStyle="#f5ffff";
        ctx.beginPath(); ctx.arc(-core*.27,-core*.16,core*.11,0,Math.PI*2); ctx.arc(core*.27,-core*.16,core*.11,0,Math.PI*2); ctx.fill();
        ctx.fillStyle=`hsla(${hue},100%,80%,.9)`;
        ctx.fillRect(-core*.12,core*.28,core*.24,core*.08);
        // floating shard fins
        ctx.fillStyle=`hsla(${hue},90%,55%,.75)`;
        ctx.beginPath(); ctx.moveTo(-core*.65,-core*.3); ctx.lineTo(-core*1.15,-core*.85); ctx.lineTo(-core*.85,core*.1); ctx.fill();
        ctx.beginPath(); ctx.moveTo(core*.65,-core*.3); ctx.lineTo(core*1.15,-core*.85); ctx.lineTo(core*.85,core*.1); ctx.fill();
      }
      ctx.restore();

      // health strip above target
      if(e.hp<e.maxHp) {
        const bw=clamp(size*.75,12,80), bh=Math.max(2,size*.025);
        ctx.fillStyle="#101820"; ctx.fillRect(sx-bw/2,top-size*.1,bw,bh);
        ctx.fillStyle="#66f4e8"; ctx.fillRect(sx-bw/2,top-size*.1,bw*(e.hp/e.maxHp),bh);
      }
    }
  }

  function renderProjectiles(w,h,horizon) {
    for(const p of projectiles) {
      const pr=project(p,w,h,horizon); if(!pr) continue;
      const s=Math.max(2,pr.size*.05);
      ctx.fillStyle="#a9fff5"; ctx.shadowColor="#66f4e8"; ctx.shadowBlur=18;
      ctx.beginPath(); ctx.arc(pr.sx,horizon,s,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
    }
  }

  function renderWeapon(w,h) {
    const sway=Math.sin(player.bob*1.7)*(player.moving?8:1);
    const x=w*.5 + sway, y=h*.91 + player.recoil*18;
    ctx.save(); ctx.translate(x,y);
    // Stylized energy caster; intentionally fictional
    ctx.shadowColor="#4bdedb"; ctx.shadowBlur=18;
    const grad=ctx.createLinearGradient(-50,-80,50,20);
    grad.addColorStop(0,"#8baab6"); grad.addColorStop(.45,"#314c5c"); grad.addColorStop(1,"#101c2a");
    ctx.fillStyle=grad; ctx.strokeStyle="#82e8e3"; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(-42,18); ctx.lineTo(-32,-62); ctx.lineTo(-16,-78); ctx.lineTo(17,-78); ctx.lineTo(35,-55); ctx.lineTo(48,20); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.shadowBlur=0;
    ctx.fillStyle="#0a1721"; ctx.fillRect(-13,-91,26,27);
    ctx.fillStyle="#66f4e8"; ctx.fillRect(-7,-88,14,19);
    ctx.fillStyle="#8afff2"; ctx.globalAlpha=.45; ctx.fillRect(-2,-84,4,11); ctx.globalAlpha=1;
    ctx.fillStyle="#182b39"; ctx.fillRect(-24,-18,48,24);
    ctx.fillStyle="#66f4e8"; ctx.fillRect(-15,-13,30,3);
    ctx.restore();
  }

  function drawVignette(w,h) {
    const v=ctx.createRadialGradient(w/2,h/2,h*.2,w/2,h/2,h*.75);
    v.addColorStop(0,"rgba(0,0,0,0)"); v.addColorStop(1,"rgba(0,0,0,.55)");
    ctx.fillStyle=v; ctx.fillRect(0,0,w,h);
  }

  function drawMinimap() {
    const s=minimap.width/MW;
    mctx.clearRect(0,0,minimap.width,minimap.height);
    for(let y=0;y<MH;y++) for(let x=0;x<MW;x++) {
      if(map[y][x]==="1") { mctx.fillStyle="#365565"; mctx.fillRect(x*s,y*s,s-1,s-1); }
    }
    for(const e of entities) { mctx.fillStyle=e.type==="brute"?"#ffae69":e.type==="wisp"?"#75dfff":"#db86ff"; mctx.beginPath(); mctx.arc(e.x*s,e.y*s,2.5,0,Math.PI*2); mctx.fill(); }
    mctx.save(); mctx.translate(player.x*s,player.y*s); mctx.rotate(player.angle);
    mctx.fillStyle="#8ffff0"; mctx.beginPath(); mctx.moveTo(7,0); mctx.lineTo(-4,-4); mctx.lineTo(-4,4); mctx.closePath(); mctx.fill(); mctx.restore();
  }

  function shoot() {
    if(!running||paused||gameOver||reloading||shootCooldown>0) return;
    if(ammo<=0) { beep(120,.08,"square",.02); showToast("OUT OF ENERGY — PRESS R"); return; }
    ammo--; shootCooldown=.24; player.recoil=1; updateHud();
    beep(180,.09,"sawtooth",.045); beep(620,.07,"triangle",.025);
    // Small muzzle flash
    for(let i=0;i<8;i++) particles.push({x:player.x+Math.cos(player.angle)*.5,y:player.y+Math.sin(player.angle)*.5,life:.18,size:.02+Math.random()*.04});
    let target=null, best=Infinity;
    for(const e of entities) {
      const dx=e.x-player.x,dy=e.y-player.y,dist=Math.hypot(dx,dy);
      const a=Math.abs(normAngle(Math.atan2(dy,dx)-player.angle));
      const aimWidth=Math.atan2(e.radius+.08,dist);
      if(a<aimWidth+.012 && dist<best) {
        // Ensure a wall does not block the shot
        const wall=raycast(player.angle);
        if(wall.dist>dist-.18) { target=e; best=dist; }
      }
    }
    if(target) {
      target.hp--; target.flash=.12; hitFlash=.12; score+=10;
      $("hit-marker").style.opacity=1;
      setTimeout(()=>$("hit-marker").style.opacity=0,90);
      beep(850,.045,"triangle",.025);
      if(target.hp<=0) {
        entities.splice(entities.indexOf(target),1); kills++; score+=50;
        showToast(target.type==="brute"?"HEAVY ENTITY CONTAINED":"ENTITY CONTAINED",.8);
        for(let i=0;i<12;i++) particles.push({x:target.x,y:target.y,life:.4+Math.random()*.4,size:.025+Math.random()*.045,angle:Math.random()*Math.PI*2});
        if(entities.length===0) {
          wave++; player.health=Math.min(100,player.health+12); ammo=12;
          showToast("SECTOR CLEAR — +12 INTEGRITY");
          setTimeout(()=>{ if(running&&!gameOver){startWave();updateHud();}},1400);
        }
      }
    }
  }

  function reload() {
    if(!running||paused||reloading||ammo===12) return;
    reloading=true; reloadTimer=1.15; showToast("RECHARGING");
    beep(280,.08,"sine",.025);
  }

  function damage(amount) {
    player.health=Math.max(0,player.health-amount); hurtFlash=.32;
    $("damage-flash").style.opacity=.85; setTimeout(()=>$("damage-flash").style.opacity=0,120);
    beep(90,.12,"sawtooth",.03); updateHud();
    if(player.health<=0) endGame();
  }

  function update(dt) {
    elapsed+=dt;
    shootCooldown=Math.max(0,shootCooldown-dt);
    player.recoil=Math.max(0,player.recoil-dt*5);
    hitFlash=Math.max(0,hitFlash-dt); hurtFlash=Math.max(0,hurtFlash-dt);
    if(toastTimer>0) { toastTimer-=dt; if(toastTimer<=0) $("toast").style.opacity=0; }
    if(reloading) { reloadTimer-=dt; if(reloadTimer<=0){ammo=12;reloading=false;showToast("ENERGY CELLS READY",.7);updateHud();} }
    if(mouseDown&&shootCooldown<=0) shoot();

    let forward=0, strafe=0;
    if(keys.KeyW||keys.ArrowUp) forward++;
    if(keys.KeyS||keys.ArrowDown) forward--;
    if(keys.KeyD) strafe++;
    if(keys.KeyA) strafe--;
    const sprint=keys.ShiftLeft||keys.ShiftRight;
    const speed=(sprint?3.5:2.45)*dt;
    const mag=Math.hypot(forward,strafe)||1; forward/=mag; strafe/=mag;
    const dx=(Math.cos(player.angle)*forward-Math.sin(player.angle)*strafe)*speed;
    const dy=(Math.sin(player.angle)*forward+Math.cos(player.angle)*strafe)*speed;
    player.moving=!!(forward||strafe);
    if(!blocked(player.x+dx,player.y)) player.x+=dx;
    if(!blocked(player.x,player.y+dy)) player.y+=dy;
    if(player.moving) player.bob+=dt*10;

    for(const e of entities) {
      e.flash=Math.max(0,e.flash-dt);
      const d=distance(e,player);
      e.phase+=dt*2.5;
      if(d> .62) {
        const vx=(player.x-e.x)/d, vy=(player.y-e.y)/d;
        const step=e.speed*dt;
        if(!blocked(e.x+vx*step,e.y,e.radius)) e.x+=vx*step;
        if(!blocked(e.x,e.y+vy*step,e.radius)) e.y+=vy*step;
      } else {
        e.attack-=dt;
        if(e.attack<=0) { damage(e.type==="brute"?13:8); e.attack=e.type==="brute"?1.25:1.05; }
      }
    }
    particles=particles.filter(p=>(p.life-=dt)>0);
    for(const p of particles) { p.x+=(Math.cos(p.angle||0)*dt*.5); p.y+=(Math.sin(p.angle||0)*dt*.5); }
    drawMinimap();
  }

  function endGame() {
    gameOver=true; running=false; mouseDown=false;
    document.exitPointerLock?.();
    $("hud").classList.add("hidden");
    overlay.classList.remove("hidden");
    $("start-btn").textContent="RESTART SIMULATION →";
    $("start-btn").innerHTML='RETRY SIMULATION <span>↻</span>';
    $("objective").textContent="SUIT INTEGRITY LOST";
    document.querySelector(".eyebrow").innerHTML="<span></span> SIMULATION TERMINATED";
    document.querySelector("h1").innerHTML='RUN <span>ENDED</span>';
    document.querySelector(".subtitle").textContent=`SECTORS CLEARED: ${wave-1} · ENTITIES CONTAINED: ${kills}`;
    document.querySelector(".intro").textContent=`Final score: ${score.toLocaleString()}. The simulation can be restarted whenever you're ready.`;
    showToast("SIMULATION TERMINATED");
  }

  function togglePause() {
    if(!running||gameOver) return;
    paused=!paused; mouseDown=false;
    if(paused) {
      document.exitPointerLock?.();
      overlay.classList.remove("hidden");
      $("start-btn").innerHTML='RESUME SIMULATION <span>→</span>';
      document.querySelector(".eyebrow").innerHTML="<span></span> SIMULATION PAUSED";
      document.querySelector("h1").innerHTML='VOID<span>LINE</span>';
      document.querySelector(".subtitle").textContent="TAKE A BREATHER";
      document.querySelector(".intro").textContent="The sector is waiting. Resume when you're ready.";
    } else {
      overlay.classList.add("hidden");
      canvas.requestPointerLock?.();
    }
  }

  function frame(now) {
    const dt=Math.min(.04,(now-lastTime)/1000||0); lastTime=now;
    if(running&&!paused&&!gameOver) update(dt);
    renderWorld();
    requestAnimationFrame(frame);
  }

  startBtn.addEventListener("click",()=>{
    if(gameOver||!running) {
      resetGame(); running=true; paused=false; gameOver=false;
      hud.classList.remove("hidden"); overlay.classList.add("hidden");
      canvas.requestPointerLock?.(); lastTime=performance.now();
    } else if(paused) togglePause();
  });
  canvas.addEventListener("click",()=>{ if(running&&!paused&&!gameOver){canvas.requestPointerLock?.();shoot();} });
  document.addEventListener("mousemove",(e)=>{
    if(document.pointerLockElement===canvas&&running&&!paused) player.angle+=e.movementX*.0024;
  });
  document.addEventListener("mousedown",(e)=>{if(e.button===0&&running&&!paused){mouseDown=true;shoot();}});
  document.addEventListener("mouseup",(e)=>{if(e.button===0)mouseDown=false;});
  document.addEventListener("keydown",(e)=>{
    keys[e.code]=true;
    if(["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code)) e.preventDefault();
    if(e.code==="KeyR") reload();
    if(e.code==="Escape") togglePause();
  });
  document.addEventListener("keyup",(e)=>keys[e.code]=false);
  document.addEventListener("contextmenu",e=>e.preventDefault());

  // Touch controls: left side moves, right side aims and fires.
  let touchMove=null, touchAim=null;
  canvas.addEventListener("touchstart",(e)=>{
    e.preventDefault();
    for(const t of e.changedTouches) {
      if(t.clientX<innerWidth*.48) touchMove={id:t.identifier,x:t.clientX,y:t.clientY,nowX:t.clientX,nowY:t.clientY};
      else {touchAim={id:t.identifier,x:t.clientX,nowX:t.clientX};shoot();}
    }
  },{passive:false});
  canvas.addEventListener("touchmove",(e)=>{
    e.preventDefault();
    for(const t of e.changedTouches) {
      if(touchMove&&t.identifier===touchMove.id){touchMove.nowX=t.clientX;touchMove.nowY=t.clientY;}
      if(touchAim&&t.identifier===touchAim.id){player.angle+=(t.clientX-touchAim.nowX)*.006;touchAim.nowX=t.clientX;}
    }
  },{passive:false});
  canvas.addEventListener("touchend",(e)=>{
    for(const t of e.changedTouches){if(touchMove&&t.identifier===touchMove.id)touchMove=null;if(touchAim&&t.identifier===touchAim.id)touchAim=null;}
  });
  const originalUpdate=update;
  update=function(dt) {
    if(touchMove) {
      const dx=touchMove.nowX-touchMove.x, dy=touchMove.nowY-touchMove.y;
      keys.KeyW=dy<-18; keys.KeyS=dy>18; keys.KeyA=dx<-18; keys.KeyD=dx>18;
    } else {keys.KeyW=keys.KeyW||false;keys.KeyS=keys.KeyS||false;keys.KeyA=keys.KeyA||false;keys.KeyD=keys.KeyD||false;}
    originalUpdate(dt);
  };

  requestAnimationFrame(frame);
})();