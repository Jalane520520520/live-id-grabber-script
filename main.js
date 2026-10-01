// 直播间主播用户名自动采集（AutoX.js v6）
// 流程：直播间 → 点左上角主播头像 → 读资料卡里的用户名 → 去重写入文件 → 关闭卡片 → 上滑下一个直播间
// 注意：全文只用 let，不要用 const。AutoX 的 Rhino 引擎里，循环体内的 const 只会赋值一次，
// 之后每轮都保留第一次的值（实测：每个直播间都记成第一个用户名、找卡片一直超时）
// 版本号：热更新加载器靠这个标记判断下载内容是否有效，悬浮窗也会显示。每次推送加 0.1
let SCRIPT_VERSION = "1.1";

auto.waitFor();

// ================= 配置 =================
// 控件 ID 来自 TikTok 实测（com.zhiliaoapp.musically，2026-10）。TikTok 更新后 ID 可能变，届时重新侦察。
let CFG = {
  outFile: "/sdcard/Download/streamers.txt",
  maxCount: 1000,                              // 抓够多少个自动停
  ids: {
    roomHeader: "acd",                         // 直播间左上角主播条（desc = "昵称,点赞数"），也用来判断“在直播间里”
    cardNick: "jkv",                           // 资料卡：昵称（粗体）
    cardUser: "r_6",                           // 资料卡：用户名（昵称下方灰字，不带 @）。注意直播间顶部条也用这个 ID，但那里是昵称
  },
  userRe: /^@?[A-Za-z0-9_.]{2,24}$/,           // 用户名格式
  cardMarkerRe: /^(\+?\s?关注|已关注|回关|Follow|Following|Follow back|Friends|Theo dõi|Đang theo dõi)$/, // 备用：卡片底部按钮文字
  headerMarkerRe: /^\+?\s?(关注|已关注|回关|Follow|Following|Follow back|Friends|Theo dõi|Đang theo dõi)/, // 通用识别：主播条里的“关注”按钮（文字或 desc 以此开头）
  idFailLimit: 3,                              // ID 识别连续失败几次后切到通用识别
  retryIdEvery: 20,                            // 通用模式下每隔多少个直播间再试一次 ID
  errorRe: /^(Retry|Network error|重试|网络错误|Thử lại|Lỗi mạng)$/, // 卡片加载失败时的文字
  avatarFallback:[0.088, 0.038],              // 找不到主播条时点击的比例坐标
  liveEntryFallback: [0.087, 0.073],           // 首页左上角 LIVE 入口的比例坐标
  swipeY: [0.55, 0.15],                        // 上滑起止（屏幕比例）。不要从 0.7 以下开始，会滑到评论区/商品卡上无效
  waitRoom: 7000,                              // 翻页后等直播间顶部条出现的最长时间 ms
  waitCard: 6000,                             // 等卡片弹出的最长时间 ms（点头像后先等 1.2s 再开始查）
  delay: [2500, 6000],                         // 每个直播间之间随机等待 ms（不得低于 2500）
  restEvery: 40,                               // 每抓多少个休息一次
  restMs: [60000, 150000],                     // 休息时长 ms
  pkgs: ["com.zhiliaoapp.musically", "com.ss.android.ugc.trill"], // TikTok 包名（国际版 / 亚洲版）
  logFile: "/sdcard/Download/grabber.log",
  lockFile: "/sdcard/Download/grabber.lock",   // 单实例锁
  autostartFlag: "/sdcard/Download/grabber_autostart", // 调试用：存在此文件则启动即运行，不用点悬浮窗
  maxRelaunch: 3,                              // 连续拉回失败几次后暂停
  maxMissStreak: 4,                            // 连续这么多次不在直播间，就重新导航进 LIVE
};
// ========================================

try { console.setGlobalLogConfig({ file: CFG.logFile }); } catch (e) {}

let DEBUG = false; // 调试日志开关（调试时改成 files.exists("/sdcard/Download/grabber_debug")）
let W = device.width, H = device.height;
let rnd = (r) => random(r[0], r[1]);
let px = (fx, fy) => [Math.round(W * fx), Math.round(H * fy)];

let seen = new Set();
if (files.exists(CFG.outFile)) {
  files.read(CFG.outFile).split("\n").forEach((l) => { l = l.trim(); if (l) seen.add(l); });
}
let running = false, count = 0, relaunchFails = 0, missStreak = 0;
let targetPkg = CFG.pkgs.filter((p) => app.getAppName(p))[0] || CFG.pkgs[0];
log("启动 v" + SCRIPT_VERSION + " 屏幕=" + W + "x" + H + " 包名=" + targetPkg + " 已有=" + seen.size);

// 必须用完整 ID：id("acd") 会被补成 currentPackage()+":id/acd"，而悬浮窗会让 currentPackage() 变成 AutoX，永远匹配不到
let byId = (s) => id(targetPkg + ":id/" + s);
// 只要真正显示在屏幕上的节点。
// 关键：TikTok 不怎么发内容变化事件，系统无障碍缓存会一直返回旧节点（实测：卡片早关了，旧卡片的昵称节点还“可见”，
// 导致每个直播间都读到同一个用户名）。所以先 refresh() 从 App 重新取一次，取不到说明节点已经不存在
let fresh = (n) => { try { return n.refresh(); } catch (e) { if (isInterrupt(e)) throw e; return false; } };
let onScreen = (n) => {
  if (!fresh(n) || !n.visibleToUser()) return false;
  let b = n.bounds();
  return b.top >= 0 && b.bottom <= H && b.height() > 0 && b.width() > 0;
};

// 等待并返回屏幕上可见的第一个匹配节点。
// 轮询别太密：每次 find() 都要遍历 TikTok 整棵控件树，会拖慢 TikTok 自己（实测 200ms 轮询时卡片要 3.5s 以上才出来）
function findVisible(sel, timeout) {
  let end = Date.now() + (timeout || 1500);
  sel = sel.visibleToUser(true);
  do {
    let n = sel.find().filter(onScreen)[0];
    if (n) return n;
    sleep(500);
  } while (Date.now() < end);
  return null;
}

function roomHeader(timeout) {
  let h = findVisible(byId(CFG.ids.roomHeader), timeout);
  if (DEBUG && h) log("调试 候选顶部条=" + byId(CFG.ids.roomHeader).find().map((n) => n.desc() + "@" + n.bounds() + "/" + n.visibleToUser()).join(" | "));
  return h;
}

// ---------------- 通用识别（不依赖控件 ID，也不依赖界面语言） ----------------
// ID 识别连续失败（TikTok 更新把控件 ID 改了）时自动启用，靠位置和文字结构找：
//   直播间 = 屏幕左上区域有一个带“关注”按钮的可点击主播条；
//   卡片   = 点击后新出现的、文字等于主播昵称的节点；用户名 = 昵称正下方符合用户名格式的那一行。
let idMode = true, idFails = 0, genRooms = 0;
let keyOf = (n) => (n.text() || "") + "@" + n.bounds().toString();
let isCountText = (t) => /^[0-9][0-9.,]*\s?[KkMmBb万]?$/.test(t);

function genericHeader(timeout) {
  let end = Date.now() + (timeout || 1500);
  do {
    let cands = clickable(true).boundsInside(0, 0, Math.round(W * 0.8), Math.round(H * 0.16)).find().filter((n) => {
      let b = n.bounds();
      if (!(b.left < W * 0.1 && b.width() > W * 0.25 && b.height() >= 70 && b.height() <= 230)) return false;
      if (!onScreen(n)) return false;
      let marks = textMatches(CFG.headerMarkerRe).find().concat(descMatches(CFG.headerMarkerRe).find());
      return marks.some((m) => { let mb = m.bounds(); return mb.centerX() >= b.left && mb.centerX() <= b.right && mb.centerY() >= b.top && mb.centerY() <= b.bottom; });
    });
    if (cands.length) {
      cands.sort((a, b) => a.bounds().left - b.bounds().left || b.bounds().width() - a.bounds().width());
      return cands[0];
    }
    sleep(500);
  } while (Date.now() < end);
  return null;
}

// 主播条里的昵称：第一个不是“关注”、不是数字的文字；没有就退回 desc 里“昵称,点赞数”的前半
function headerNick(h) {
  let hb = h.bounds();
  let ts = textMatches(/.+/).boundsInside(hb.left, hb.top, hb.right, hb.bottom).find().filter((n) => {
    let t = (n.text() || "").trim();
    return t && !CFG.headerMarkerRe.test(t) && !isCountText(t);
  });
  ts.sort((a, b) => a.bounds().top - b.bounds().top || a.bounds().left - b.bounds().left);
  if (ts.length) return (ts[0].text() || "").trim();
  return (h.desc() || "").replace(/,[^,]*$/, "").trim();
}

let anyHeader = (timeout) => (idMode ? roomHeader(timeout) : genericHeader(timeout));

function textKeys() {
  let st = new Set();
  textMatches(/.+/).find().forEach((n) => { st.add(keyOf(n)); });
  return st;
}

// 等卡片：找新出现的、文字等于昵称的节点（在主播条下方，靠右，避开评论区那一列），再取它正下方的用户名
function waitGenericCard(nick, hb, before, timeout) {
  let end = Date.now() + timeout;
  do {
    let nicks = text(nick).find().filter((n) => {
      if (!onScreen(n)) return false;
      let b = n.bounds();
      return b.top > hb.bottom + 40 && b.left > W * 0.2 && !before.has(keyOf(n));
    });
    nicks.sort((a, b) => a.bounds().top - b.bounds().top);
    for (let i = 0; i < nicks.length; i++) {
      let nb = nicks[i].bounds();
      let us = textMatches(CFG.userRe).find().filter((n) => {
        if (!onScreen(n)) return false;
        let b = n.bounds();
        return Math.abs(b.left - nb.left) < 40 && b.top >= nb.bottom - 20 && b.top - nb.bottom < 160;
      });
      if (us.length) return (us[0].text() || "").trim();
    }
    sleep(500);
  } while (Date.now() < end);
  return null;
}

function closeCardGeneric(nick) {
  back();
  sleep(random(700, 1000));
  if (genericHeader(2500)) return;
  let still = nick
    ? text(nick).find().filter((n) => onScreen(n) && n.bounds().left > W * 0.2 && n.bounds().top > H * 0.15)[0]
    : findVisible(textMatches(CFG.errorRe), 300);
  if (still) {
    log("卡片没关掉，再按一次返回");
    back();
    sleep(1000);
  }
}

// 通用版的 grabOne：返回 {id, nick} 或 {skip: 原因}
function grabOneGeneric() {
  if (!genericHeader(1000) && findVisible(textMatches(CFG.errorRe), 300)) { log("有残留的资料卡，先关掉"); closeCardGeneric(""); }
  let header = genericHeader(CFG.waitRoom);
  if (!header) return { skip: "非直播页 前台=" + curPkg() + " 首页=" + onHomeFeed() };
  let hb = header.bounds();
  let roomNick = headerNick(header);
  if (!roomNick) return { skip: "读不到直播间昵称" };
  let before = textKeys();
  if (!header.click()) click.apply(null, px(CFG.avatarFallback[0], CFG.avatarFallback[1]));
  sleep(1200);
  let user = waitGenericCard(roomNick, hb, before, CFG.waitCard);
  if (!user) {
    if (!genericHeader(500) && (findOneText(CFG.cardMarkerRe) || findOneText(CFG.errorRe))) back();
    return { skip: "卡片没弹出" };
  }
  closeCardGeneric(roomNick);
  return { id: "@" + user.replace(/^@/, ""), nick: roomNick, mode: "通用" };
}

// 在首页的“推荐 / For You”信息流里
function onHomeFeed() {
  return text("For You").exists() || desc("For You").exists() || text("推荐").exists() ||
    text("Dành cho bạn").exists() || desc("Dành cho bạn").exists();
}

// 在首页点左上角 LIVE 入口进入直播流；返回是否已进入直播间
function enterLive() {
  for (let i = 0; i < 4; i++) {
    if (anyHeader(1000)) return true;
    let entry = className("android.widget.ImageView").clickable(true)
      .boundsInside(0, 0, Math.round(W * 0.2), Math.round(H * 0.13)).findOne(1000);
    let onHome = onHomeFeed();
    if (entry && onHome) {
      log("在首页，点 LIVE 入口");
      entry.click() || press(entry.bounds().centerX(), entry.bounds().centerY(), 60);
    } else if (onHome || desc("Home").exists() || text("Home").exists()) {
      log("在首页，按坐标点 LIVE 入口");
      click.apply(null, px(CFG.liveEntryFallback[0], CFG.liveEntryFallback[1]));
    } else {
      log("不在首页也不在直播间，按返回");
      back();
    }
    sleep(4000);
  }
  return !!anyHeader(1500);
}

// 当前前台包名。优先读活动窗口根节点：currentPackage() 刚启动时是空串，
// 而且自己的悬浮窗一出现就会变成 AutoX 的包名（实测），不可靠
function curPkg() {
  try { let r = auto.root; if (r && r.packageName()) return String(r.packageName()); } catch (e) {}
  return currentPackage() || "";
}

// 离开 TikTok 时自动拉回并进入 LIVE；返回是否已回到 App
function ensureInApp() {
  if (curPkg() === targetPkg) { relaunchFails = 0; return true; }
  log("不在 TikTok（当前 " + curPkg() + "），尝试拉回");
  app.launch(targetPkg);
  sleep(6000);
  if (curPkg() === targetPkg) {
    relaunchFails = 0;
    if (!enterLive()) log("拉回后没能进入 LIVE");
    return true;
  }
  relaunchFails++;
  return false;
}

// 卡片里的用户名节点：昵称正下方的 r_6
function cardUser(nick) {
  let nb = nick.bounds();
  let cands = byId(CFG.ids.cardUser).visibleToUser(true).find().filter((n) => {
    if (!onScreen(n)) return false;
    let b = n.bounds();
    return b.top >= nb.bottom - 20 && b.top - nb.bottom < 150;
  });
  if (cands.length) return (cands[0].text() || "").trim();
  // 备用：昵称下方第一个符合用户名格式的文字
  let alt = textMatches(CFG.userRe).find().filter((n) => {
    if (!onScreen(n)) return false;
    let b = n.bounds();
    return b.top >= nb.bottom - 20 && b.top - nb.bottom < 150;
  });
  return alt.length ? (alt[0].text() || "").trim() : "";
}

// 关卡片：返回一次，等直播间顶部条重新出现。只有确认卡片还在时才再按一次返回，
// 否则多按的返回会直接退出直播间（实测出现过）
function closeCard() {
  back();
  sleep(random(700, 1000));
  if (roomHeader(2500)) return;
  if (findVisible(byId(CFG.ids.cardNick), 500)) {
    log("卡片没关掉，再按一次返回");
    back();
    sleep(1000);
  }
}

// 返回 {id, nick} 或 {skip: 原因}
function grabOne() {
  // 翻页后新直播间的控件要过几秒才出现在无障碍树里（实测 2s 不够）
  let th = Date.now();
  // 上一轮留下的资料卡还开着（脚本中途停止、卡片关闭失败等），先关掉
  // 也包括网络抖动时卡片显示 “Network error / Retry”、没有昵称节点的情况（实测卡住过 2.5 分钟）
  if (!roomHeader(1000) && (findVisible(byId(CFG.ids.cardNick), 500) || findVisible(textMatches(CFG.errorRe), 300))) {
    log("有残留的资料卡，先关掉");
    closeCard();
  }
  let header = roomHeader(CFG.waitRoom);
  if (DEBUG && header) log("调试 顶部条出现用时=" + (Date.now() - th));
  if (!header) {
    let info = "";
    try {
      info = " 前台=" + curPkg() + " 首页=" + onHomeFeed() + " acd=" +
        byId(CFG.ids.roomHeader).find().map((n) => n.bounds() + "/" + n.visibleToUser()).join(";");
    } catch (e) { info += " 调试出错 " + e; }
    return { skip: "非直播页" + info };
  }
  let roomNick = (header.desc() || "").replace(/,[^,]*$/, "").trim(); // "昵称,点赞数" → 昵称

  // 用无障碍点击动作：实测有悬浮窗时 click(x,y)/press() 手势点不开卡片，header.click() 可以
  let clicked = header.click();
  if (!clicked) click.apply(null, px(CFG.avatarFallback[0], CFG.avatarFallback[1]));

  let t0 = Date.now();
  sleep(1200); // 卡片加载要时间，先别查
  let nick = findVisible(byId(CFG.ids.cardNick), CFG.waitCard);
  if (DEBUG) log("调试 click=" + clicked + " 用时=" + (Date.now() - t0) + " jkv全部=" + byId(CFG.ids.cardNick).find().map((n) => n.bounds() + "/vis=" + n.visibleToUser() + "/on=" + onScreen(n)).join(";") +
    " root=" + curPkg() + " header仍在=" + !!byId(CFG.ids.roomHeader).findOnce());
  if (!nick) {
    // 卡片没弹出：如果还在直播间就不用返回，免得退出直播间
    if (!roomHeader(500) && (findOneText(CFG.cardMarkerRe) || findOneText(CFG.errorRe))) back();
    return { skip: "卡片没弹出" };
  }
  sleep(300);
  let user = cardUser(nick);
  let cardNick = (nick.text() || "").trim();
  if (DEBUG) log("调试 读卡 房间=" + roomNick + " 卡片昵称=" + cardNick + "@" + nick.bounds() + " 用户名=" + user +
    " r_6候选=" + byId(CFG.ids.cardUser).find().map((n) => (n.text() || "") + "@" + n.bounds() + "/" + fresh(n) + "→" + (n.text() || "")).join(" | "));
  closeCard();

  if (!user || !CFG.userRe.test(user)) return { skip: "卡片里没读到用户名 [" + user + "]" };
  if (roomNick && cardNick && roomNick !== cardNick) {
    return { skip: "卡片和直播间不一致 房间=" + roomNick + " 卡片=" + cardNick };
  }
  return { id: "@" + user.replace(/^@/, ""), nick: cardNick };
}

function findOneText(re) {
  return textMatches(re).findOnce() || descMatches(re).findOnce();
}

// 用昵称（不带点赞数，点赞数会一直变）判断是不是换了直播间
let headerDesc = (timeout) => { let h = anyHeader(timeout || 800); return h ? headerNick(h) : ""; };

// 翻到下一个直播间。首选 ViewPager 的无障碍翻页动作（实测有悬浮窗时手势经常不生效），
// 不行再用上滑手势；用顶部条的“昵称,点赞数”判断是否真的换了直播间
function nextLive() {
  let before = headerDesc(2500);
  let pager = className("androidx.viewpager.widget.ViewPager").scrollable(true).findOnce();
  if (!(pager && pager.scrollForward())) {
    let x = W / 2 + random(-60, 60);
    swipe(x, H * CFG.swipeY[0] + random(-40, 40), x + random(-30, 30), H * CFG.swipeY[1], random(180, 300));
  }
  sleep(random(2000, 3000)); // 等直播间加载
  let after = headerDesc(1500);
  if (DEBUG) log("调试 翻页 前=" + before + " pager=" + !!pager + " 后=" + after);
  if (before && after === before) {
    log("没换到下一个直播间，改用上滑手势");
    let sx = W / 2 + random(-60, 60);
    swipe(sx, H * CFG.swipeY[0], sx, H * CFG.swipeY[1], random(180, 300));
    sleep(2500);
  }
}

// ---------------- 悬浮窗 ----------------
let win = floaty.window(
  <vertical bg="#aa000000" padding="6">
    <text id="info" textColor="#ffffff" textSize="12sp" text="待开始"/>
    <horizontal>
      <button id="toggle" text="开始" w="64" h="40" textSize="12sp"/>
      <button id="quit" text="退出" w="64" h="40" textSize="12sp"/>
    </horizontal>
  </vertical>
);
// 贴右边、屏幕 40% 高度处；按实际宽度放，避免出屏
ui.post(() => win.setPosition(Math.max(0, W - win.getWidth()), Math.round(H * 0.4)), 300);
let setInfo = (s) => ui.run(() => win.info.setText("v" + SCRIPT_VERSION + " " + s));
setInfo("待开始");

win.toggle.click(() => {
  running = !running;
  win.toggle.setText(running ? "暂停" : "开始");
  setInfo(running ? "运行中 已抓 " + count : "已暂停 已抓 " + count);
  log(running ? "开始" : "暂停");
});
win.quit.click(() => { log("退出"); win.close(); exit(); });

// ---------------- 主循环 ----------------
// 脚本被停止时让工作线程也退出（否则线程会成为孤儿继续操作手机，和新启动的脚本互相打架）
let stopped = false;
events.on("exit", () => { stopped = true; });
let isInterrupt = (e) => /Interrupt/i.test(String(e)) || /Interrupt/i.test(String(e && e.javaException));
// 单实例锁：每次启动写入自己的令牌；发现令牌被新实例换掉就退出。
// 实测停止信号会被各处的 try/catch 吞掉，光靠 exit 事件不够
let myToken = String(Date.now()) + "-" + random(1000, 9999);
files.write(CFG.lockFile, myToken);
let isCurrent = () => { try { return files.read(CFG.lockFile) === myToken; } catch (e) { return true; } };

threads.start(function () {
  while (!stopped) {
    if (!isCurrent()) { log("发现新启动的实例，本实例退出"); break; }
    if (!running) { sleep(500); continue; }
    if (!ensureInApp()) {
      if (relaunchFails >= CFG.maxRelaunch) {
        running = false;
        ui.run(() => win.toggle.setText("开始"));
        setInfo("无法回到 TikTok，已暂停");
        log("连续拉回失败，暂停");
      }
      continue;
    }
    try {
      let r = null;
      if (idMode) {
        r = grabOne();
        if (r.id) idFails = 0;
        else if (/^(非直播页|卡片没弹出|卡片里没读到用户名)/.test(r.skip) && !onHomeFeed()) {
          // “非直播页”：通用识别能看到主播条而 ID 看不到 → ID 失效，这个直播间直接用通用识别补抓，不浪费；
          // 两边都看不到只是当前不在直播间（弹窗、直播结束页等），不算 ID 失效
          let idBroken = true;
          if (r.skip.indexOf("非直播页") === 0) {
            idBroken = !!genericHeader(800);
            if (idBroken) { let rg = grabOneGeneric(); if (rg.id) r = rg; }
          }
          if (idBroken && ++idFails >= CFG.idFailLimit) {
            idMode = false; genRooms = 0;
            log("ID 识别连续失败 " + idFails + " 次，切换到通用识别");
          }
        }
      } else {
        genRooms++;
        if (genRooms % CFG.retryIdEvery === 0) { // 每隔一段时间再试一次 ID
          let rr = grabOne();
          if (rr.id) { idMode = true; idFails = 0; r = rr; log("ID 识别恢复，切回 ID 识别"); }
        }
        if (!r) r = grabOneGeneric();
      }
      let tag = "[" + (r.mode || (idMode ? "ID" : "通用")) + "] ";
      let added = false;
      if (r.id) {
        missStreak = 0;
        added = !seen.has(r.id);
        if (added) {
          seen.add(r.id);
          files.append(CFG.outFile, r.id + "\n");
          count++;
          log(tag + "新增 " + r.id + " (" + r.nick + ")");
        } else {
          log(tag + "重复 " + r.id);
        }
      } else {
        log(tag + "跳过：" + r.skip);
        if (r.skip.indexOf("非直播页") === 0 && (onHomeFeed() || ++missStreak >= CFG.maxMissStreak)) {
          log("连续 " + missStreak + " 次不在直播间，重新进入 LIVE");
          enterLive();
          missStreak = 0;
          continue;
        }
      }
      setInfo("运行中 已抓 " + count + " / 总 " + seen.size);

      if (count >= CFG.maxCount) { running = false; setInfo("已达上限 " + count); log("已达上限"); continue; }
      if (added && count % CFG.restEvery === 0) {
        let ms = rnd(CFG.restMs);
        setInfo("休息 " + Math.round(ms / 1000) + "s");
        log("休息 " + Math.round(ms / 1000) + "s");
        sleep(ms);
      }
      nextLive();
      sleep(rnd(CFG.delay));
    } catch (e) {
      if (stopped || isInterrupt(e)) break; // 被停止，不能吞掉这个异常
      log("出错: " + e);
      sleep(2000);
    }
  }
});

if (files.exists(CFG.autostartFlag)) {
  running = true;
  ui.run(() => win.toggle.setText("暂停"));
  setInfo("自动运行中");
  log("AUTOSTART 已开启");
}

setInterval(() => {}, 1000);
