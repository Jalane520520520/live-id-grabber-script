// 直播间主播用户名自动采集（AutoX.js v6）
// 流程：直播间 → 点左上角主播头像 → 读资料卡里的用户名 → 去重写入文件 → 关闭卡片 → 上滑下一个直播间
// 注意：全文只用 let，不要用 const。AutoX 的 Rhino 引擎里，循环体内的 const 只会赋值一次，
// 之后每轮都保留第一次的值（实测：每个直播间都记成第一个用户名、找卡片一直超时）
// 版本号：热更新加载器靠这个标记判断下载内容是否有效，悬浮窗也会显示。每次推送加 0.1
let SCRIPT_VERSION = "1.2";

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
  // ---- 节奏：和 v1.1 一样（最快档）----
  delay: [2500, 6000],                         // 每个直播间之间随机等待 ms（不得低于 2500）
  restEvery: 40,                               // 每抓多少个休息一次
  restMs: [60000, 150000],                     // 休息时长 ms
  pressMs: [60, 150],                          // 点击按下时长
  swipeMs: [300, 700],                         // 上滑时长
  pkgs: ["com.zhiliaoapp.musically", "com.ss.android.ugc.trill"], // TikTok 包名（国际版 / 亚洲版）
  logFile: "/sdcard/Download/grabber.log",
  lockFile: "/sdcard/Download/grabber.lock",   // 单实例锁
  autostartFlag: "/sdcard/Download/grabber_autostart", // 调试用：存在此文件则启动即运行，不用点悬浮窗
  maxRelaunch: 3,                              // 连续拉回失败几次后暂停
  netUrl: "https://www.tiktok.com",           // 网络检测：能拿到任何 HTTP 响应就算通
  netTimeoutMs: 5000,                          // 单次检测超时
  netCheckMs: 5 * 60 * 1000,                   // 正常运行时每隔多久检测一次
  netRetryMs: 30 * 1000,                       // 网络断开后每隔多久重试
  netSuspectStreak: 3,                         // 连续这么多次进不了 LIVE / 读不到卡片，就检测一次
  nonLiveStreak: 2,                            // 连续这么多次不是直播间画面（且不是网络问题），就退避
  backoffFails: 3,                             // 退避后仍没回到直播间，累计这么多次就暂停等人看一下
  backoffWindowMs: 10 * 60 * 1000,             // ……在这个时间窗口内
};
// ========================================

try { console.setGlobalLogConfig({ file: CFG.logFile }); } catch (e) {}

let DEBUG = false; // 调试日志开关（调试时改成 files.exists("/sdcard/Download/grabber_debug")）
let W = device.width, H = device.height;
let rnd = (r) => random(r[0], r[1]);
let px = (fx, fy) => [Math.round(W * fx), Math.round(H * fy)];

// 用户名不带 @。旧文件里带 @ 的记录启动时统一去掉 @，同一个名字带不带 @ 只算一个
let seen = new Set();
if (files.exists(CFG.outFile)) {
  let uniq = [], changed = false;
  files.read(CFG.outFile).split("\n").forEach((l) => {
    l = l.trim();
    if (!l) return;
    let n = l.replace(/^@+/, "");
    if (n !== l) changed = true;
    if (seen.has(n)) { changed = true; return; }
    seen.add(n); uniq.push(n);
  });
  if (changed) {
    files.write(CFG.outFile, uniq.length ? uniq.join("\n") + "\n" : "");
    log("已把旧文件里的 @ 去掉并去重，共 " + uniq.length + " 个");
  }
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
  humanTap(header);
  sleep(1200);
  let user = waitGenericCard(roomNick, hb, before, 2500);
  if (!user) {
    log("手势没点开卡片，改用无障碍点击");
    if (!header.click()) click.apply(null, px(CFG.avatarFallback[0], CFG.avatarFallback[1]));
    sleep(800);
    user = waitGenericCard(roomNick, hb, before, CFG.waitCard);
  }
  if (!user) {
    if (!genericHeader(500) && (findOneText(CFG.cardMarkerRe) || findOneText(CFG.errorRe))) back();
    return { skip: "卡片没弹出" };
  }
  closeCardGeneric(roomNick);
  return { id: user.replace(/^@+/, ""), nick: roomNick, mode: "通用" };
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

  // 先用拟人手势点头像；手势没点开就退回无障碍点击（实测有悬浮窗时手势偶尔点不开，header.click() 可靠）
  let clicked = humanTap(header);
  let t0 = Date.now();
  sleep(1200); // 卡片加载要时间，先别查
  let nick = findVisible(byId(CFG.ids.cardNick), 2500);
  if (!nick) {
    log("手势没点开卡片，改用无障碍点击");
    clicked = header.click();
    if (!clicked) click.apply(null, px(CFG.avatarFallback[0], CFG.avatarFallback[1]));
    sleep(800);
    nick = findVisible(byId(CFG.ids.cardNick), CFG.waitCard);
  }
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
  return { id: user.replace(/^@+/, ""), nick: cardNick };
}

// 拟人点击：只点主播条最左边的头像范围（避开右边的“关注”按钮，免得误关注主播），位置随机偏移，按下 60–150 毫秒。
// 手势在个别情况下点不开（见 CLAUDE.md），所以点完要检查卡片，没开就退回无障碍点击
function humanTap(node) {
  try {
    let b = node.bounds(), h = b.height();
    let x = random(b.left + Math.round(h * 0.2), b.left + Math.round(h * 0.8));
    let y = random(b.top + Math.round(h * 0.25), b.bottom - Math.round(h * 0.25));
    return press(x, y, rnd(CFG.pressMs));
  } catch (e) { if (isInterrupt(e)) throw e; return false; }
}
// 拟人上滑：起止点随机，中间带弯曲，时长 300–700 毫秒
function humanSwipe() {
  let x0 = W / 2 + random(-90, 90), y0 = Math.round(H * (CFG.swipeY[0] + random(-4, 4) / 100));
  let y1 = Math.round(H * (CFG.swipeY[1] + random(-3, 3) / 100)), x1 = x0 + random(-70, 70);
  let bow = random(-80, 80);
  let ym = y0 + Math.round((y1 - y0) * (0.35 + random(0, 20) / 100));
  return gesture(rnd(CFG.swipeMs), [x0, y0], [x0 + bow, ym], [x1, y1]);
}

function findOneText(re) {
  return textMatches(re).findOnce() || descMatches(re).findOnce();
}

// 用昵称（不带点赞数，点赞数会一直变）判断是不是换了直播间
let headerDesc = (timeout) => { let h = anyHeader(timeout || 800); return h ? headerNick(h) : ""; };

// 翻到下一个直播间。先用拟人的弯曲上滑；没换房间就用 ViewPager 的无障碍翻页动作，再不行用直线上滑。
// 用顶部条的昵称判断是否真的换了直播间
function nextLive() {
  let before = headerDesc(2500);
  humanSwipe();
  sleep(random(2000, 3000)); // 等直播间加载
  let after = headerDesc(1500);
  if (before && after === before) {
    log("弯曲上滑没换房间，改用无障碍翻页");
    let pager = className("androidx.viewpager.widget.ViewPager").scrollable(true).findOnce();
    if (!(pager && pager.scrollForward())) {
      let sx = W / 2 + random(-60, 60);
      swipe(sx, H * CFG.swipeY[0], sx, H * CFG.swipeY[1], random(180, 300));
    }
    sleep(random(2000, 3000));
  }
}

// ---------------- 网络检测 ----------------
// 请求 TikTok 首页，5 秒超时。拿到任何 HTTP 响应（哪怕 403）都说明网络和 VPN 是通的
function netOk() {
  let ok = false;
  let t = threads.start(function () {
    try { let r = http.get(CFG.netUrl, { headers: { "Cache-Control": "no-cache" } }); ok = !!r && r.statusCode > 0; } catch (e) { ok = false; }
  });
  t.join(CFG.netTimeoutMs);
  if (t.isAlive()) { t.interrupt(); ok = false; }
  return ok;
}

// ---------------- 悬浮窗 ----------------
let win = floaty.window(
  <vertical bg="#aa000000" padding="6">
    <text id="info" textColor="#ffffff" textSize="12sp" text="待开始"/>
    <horizontal>
      <button id="toggle" text="开始" w="64" h="40" textSize="12sp"/>
      <button id="quit" text="退出" w="64" h="40" textSize="12sp"/>
    </horizontal>
    <horizontal>
      <button id="copy" text="复制全部" w="64" h="40" textSize="11sp"/>
      <button id="share" text="分享" w="64" h="40" textSize="11sp"/>
    </horizontal>
  </vertical>
);
// 贴右边、屏幕 40% 高度处；按实际宽度放，避免出屏
ui.post(() => win.setPosition(Math.max(0, W - win.getWidth()), Math.round(H * 0.4)), 300);
// 文字变长后窗口会向右伸出屏幕（警告语被截断），所以每次改字后重新贴右边
let setInfo = (s) => {
  ui.run(() => win.info.setText("v" + SCRIPT_VERSION + " " + s));
  ui.post(() => win.setPosition(Math.max(0, W - win.getWidth()), Math.round(H * 0.4)), 200);
};
setInfo("待开始");

win.toggle.click(() => {
  running = !running;
  win.toggle.setText(running ? "暂停" : "开始");
  setInfo(running ? "运行中 已抓 " + count : "已暂停 已抓 " + count);
  log(running ? "开始" : "暂停");
});
win.quit.click(() => { log("退出"); win.close(); exit(); });

// ---------------- 结果导出（2.10） ----------------
let readNames = () => (files.exists(CFG.outFile) ? files.read(CFG.outFile).split("\n").map((l) => l.trim().replace(/^@+/, "")).filter((l) => l) : []);
// 复制全部：每行一个用户名，放进剪贴板，提示“已复制 N 个”
win.copy.click(() => {
  try {
    let names = readNames();
    setClip(names.join("\n"));
    toast("已复制 " + names.length + " 个");
    log("复制全部 " + names.length + " 个");
  } catch (e) { toast("复制失败：" + e); log("复制失败: " + e); }
});
// 分享：用安卓分享菜单发送 streamers.txt（可直接选微信）；文件分享不成功就退回分享纯文本
win.share.click(() => {
  try {
    let I = android.content.Intent;
    if (!files.exists(CFG.outFile) || !readNames().length) { toast("还没有结果可分享"); return; }
    let it = new I(I.ACTION_SEND), how = "文件";
    try {
      let uri = app.getUriForFile(CFG.outFile);
      it.setType("text/plain");
      it.putExtra(I.EXTRA_STREAM, uri);
      it.addFlags(I.FLAG_GRANT_READ_URI_PERMISSION);
    } catch (e) {
      how = "文本";
      log("文件分享不可用，改分享文本: " + e);
      it = new I(I.ACTION_SEND);
      it.setType("text/plain");
      it.putExtra(I.EXTRA_TEXT, readNames().join("\n"));
    }
    let ch = I.createChooser(it, "分享主播列表");
    ch.addFlags(I.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(ch);
    log("分享（" + how + "）");
  } catch (e) { toast("分享失败：" + e); log("分享失败: " + e); }
});

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

// ---------------- 通用自动退避（2.7） ----------------
// 不识别具体是什么窗口（滑块、广告、别的页面都一样），只看“是不是直播间画面”：
// 连续 2 次不是直播间画面、并且不是网络问题 → 按返回 → 还不是 → 强制关闭并重启 TikTok → 自动进入 LIVE → 继续抓
let nonLive = 0, backoffFailTimes = [], haltedByBackoff = false;

// 强制关闭 TikTok：打开系统的应用信息页点“强行停止”（各品牌的文字不同，用正则匹配）；点不到就退一步用 killBackgroundProcesses
function stopTikTok() {
  let clickNode = (n) => { if (!n) return false; if (n.click()) return true; let b = n.bounds(); return click(b.centerX(), b.centerY()); };
  let done = false;
  try {
    app.openAppSetting(targetPkg);
    sleep(2500);
    let btn = textMatches(/^(强行停止|强制停止|结束运行|Force stop|FORCE STOP|Force Stop)$/).findOne(4000);
    if (btn && btn.enabled()) {
      clickNode(btn);
      sleep(1200);
      // 确认弹窗：优先用系统对话框的确定键，找不到再按文字
      let ok = id("android:id/button1").findOne(2500) || textMatches(/^(确定|OK|ok)$/).findOne(1500);
      if (ok) { clickNode(ok); done = true; sleep(1500); }
    }
  } catch (e) { if (isInterrupt(e)) throw e; log("强行停止出错: " + e); }
  if (!done) {
    log("没点到“强行停止”，改用 killBackgroundProcesses");
    try { home(); sleep(1000); context.getSystemService("activity").killBackgroundProcesses(targetPkg); sleep(1500); done = true; }
    catch (e) { if (isInterrupt(e)) throw e; log("killBackgroundProcesses 失败: " + e); }
  }
  return done;
}

// 返回是否已回到直播间
function backoff() {
  log("退避：按返回");
  back();
  sleep(random(1500, 2500));
  if (anyHeader(2500)) return true;
  log("退避：还不是直播间，强制关闭并重启 TikTok");
  stopTikTok();
  app.launch(targetPkg);
  sleep(7000);
  if (enterLive()) return true;
  return !!anyHeader(3000);
}

// 休息：每秒检查一次，用户点暂停或退出能立刻响应
function nap(ms, label, logLabel) {
  log(logLabel + " " + Math.round(ms / 1000) + "s");
  for (let w = 0; w < ms && !stopped && running; w += 1000) {
    setInfo(label + "中，约 " + Math.max(1, Math.round((ms - w) / 60000)) + " 分钟后继续");
    sleep(1000);
  }
}

let lastNetCheck = 0, netSuspect = 0;
// 检测网络；断开时自动暂停，每 30 秒重试，恢复后自动继续，不需要客户操作。返回 false 表示等待期间被用户暂停或退出
function ensureNet(reason) {
  if (netOk()) { lastNetCheck = Date.now(); return true; }
  log("网络检测失败（" + reason + "），暂停，每 " + CFG.netRetryMs / 1000 + " 秒重试");
  while (!stopped && isCurrent() && running) {
    setInfo("⚠️ 网络断开，请检查网络 / VPN");
    for (let w = 0; w < CFG.netRetryMs && !stopped && running; w += 1000) sleep(1000);
    if (stopped || !running) return false;
    if (netOk()) {
      log("网络恢复，自动继续");
      setInfo("网络恢复，继续运行");
      lastNetCheck = Date.now(); netSuspect = 0; missStreak = 0;
      return true;
    }
  }
  return false;
}

threads.start(function () {
  while (!stopped) {
    if (!isCurrent()) { log("发现新启动的实例，本实例退出"); break; }
    if (!running) { sleep(500); continue; }
    if (haltedByBackoff) { haltedByBackoff = false; backoffFailTimes = []; nonLive = 0; log("人工恢复，重新开始计数"); }
    if (Date.now() - lastNetCheck >= CFG.netCheckMs && !ensureNet(lastNetCheck ? "定时" : "启动")) continue;
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
        if (r.skip.indexOf("非直播页") === 0) {
          if (onHomeFeed()) { // 被带回了首页：直接重新进入 LIVE，不算退避
            log("在首页，重新进入 LIVE");
            enterLive(); nonLive = 0;
            continue;
          }
          if (++nonLive >= CFG.nonLiveStreak) {
            nonLive = 0;
            if (!netOk()) { ensureNet("连续不是直播间画面"); continue; } // 网络问题走断网流程，不退避
            let now = Date.now();
            if (backoff()) { backoffFailTimes = []; log("退避成功，继续抓取"); }
            else {
              backoffFailTimes.push(now);
              backoffFailTimes = backoffFailTimes.filter((t) => now - t <= CFG.backoffWindowMs);
              log("退避后仍不是直播间（" + backoffFailTimes.length + "/" + CFG.backoffFails + "）");
              if (backoffFailTimes.length >= CFG.backoffFails) {
                running = false; haltedByBackoff = true;
                ui.run(() => win.toggle.setText("开始"));
                setInfo("⚠️ TikTok 一直弹窗，请看一下手机");
                log("退避 " + CFG.backoffFails + " 次都没恢复，暂停，等人处理后点开始");
              }
            }
            continue;
          }
        } else { nonLive = 0; }
      }
      if (r.id) { netSuspect = 0; nonLive = 0; }
      else if (/^(非直播页|卡片没弹出)/.test(r.skip)) {
        // 连续进不了 LIVE，或者卡片上出现 “Network error / Retry”，都检测一次网络
        netSuspect++;
        if (netSuspect >= CFG.netSuspectStreak || findVisible(textMatches(CFG.errorRe), 300)) {
          netSuspect = 0;
          if (!ensureNet("连续失败/网络错误")) continue;
        }
      }
      setInfo("运行中 已抓 " + count + " / 总 " + seen.size);

      if (count >= CFG.maxCount) { running = false; setInfo("已达上限 " + count); log("已达上限"); continue; }
      if (added && count % CFG.restEvery === 0) nap(rnd(CFG.restMs), "休息", "休息");
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
