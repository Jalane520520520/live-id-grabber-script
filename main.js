// 直播间主播用户名自动采集（AutoX.js v6）
// 流程：直播间 → 点左上角主播头像 → 读资料卡里的用户名 → 去重写入文件 → 关闭卡片 → 上滑下一个直播间
// 注意：全文只用 let，不要用 const。AutoX 的 Rhino 引擎里，循环体内的 const 只会赋值一次，
// 之后每轮都保留第一次的值（实测：每个直播间都记成第一个用户名、找卡片一直超时）
// 版本号：热更新加载器靠这个标记判断下载内容是否有效，悬浮窗也会显示。每次推送加 0.1
let SCRIPT_VERSION = "1.3";

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
  plainUrl: "https://www.baidu.com",           // 普通网站：它通而 TikTok 不通 = VPN 断开；两个都不通 = 没有网络
  netTimeoutMs: 5000,                          // 单次检测超时（定时检测）
  netFailTimeoutMs: 3000,                      // 任何失败发生时的那次检测用 3 秒
  netCheckMs: 5 * 60 * 1000,                   // 正常运行时每隔多久检测一次
  netRetryMs: 15 * 1000,                       // 网络断开后每隔多久重试
  netSuspectStreak: 3,                         // 连续这么多次进不了 LIVE / 读不到卡片，就检测一次
  nonLiveStreak: 2,                            // 连续这么多次不是直播间画面（且不是网络问题），就退避
  backoffFails: 3,                             // 退避后仍没回到直播间，累计这么多次就暂停等人看一下
  backoffWindowMs: 10 * 60 * 1000,             // ……在这个时间窗口内
  liveFailLimit: 3,                            // 网络正常但连续这么多次进不了直播间，就暂停等人处理
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
let running = false, count = 0, relaunchFails = 0, missStreak = 0, liveFails = 0;
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

// 进入 LIVE，并统计“连续进不了直播间”的次数（网络正常时连续 CFG.liveFailLimit 次就暂停，见主循环）
function enterLiveCounted(where) {
  if (enterLive()) { liveFails = 0; return true; }
  liveFails++;
  log(where + "没能进入 LIVE（" + liveFails + "/" + CFG.liveFailLimit + "）");
  netGate(where + "没能进入 LIVE");
  return false;
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
  setState("recover", "离开了 TikTok");
  app.launch(targetPkg);
  sleep(6000);
  if (curPkg() === targetPkg) {
    relaunchFails = 0;
    if (enterLiveCounted("拉回后")) setState("run");
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
// 上滑的横坐标：避开悬浮窗的实时位置（悬浮窗可以拖动，所以每次都现取）。
// 手势起点落在悬浮窗上会被悬浮窗吃掉，自定义上滑就静默失败（v1.2 实测 9/10 退回旧方式）。
// spread = 路径左右最多偏离起点多少；离屏幕边缘留 8%，免得触发系统的边缘返回手势
function swipeX(y0, y1, spread) {
  let lo = Math.round(W * 0.08) + spread, hi = Math.round(W * 0.92) - spread;
  let x = Math.round(W / 2) + random(-90, 90);
  try {
    // 胶囊外面那层看不见的边框也会挡手势，一起避开
    let gap = Math.max(0, Math.round((win.getWidth() - fw()) / 2)) + dp(8);
    let fl = win.getX() - gap, fr = win.getX() + fw() + gap, ft = win.getY() - gap, fb = win.getY() + fh() + gap;
    if (fb > Math.min(y0, y1) && ft < Math.max(y0, y1) && x + spread > fl && x - spread < fr) {
      let l1 = lo, h1 = Math.min(hi, Math.round(fl) - spread); // 悬浮窗左边的空间
      let l2 = Math.max(lo, Math.round(fr) + spread), h2 = hi;  // 悬浮窗右边的空间
      if (h1 - l1 >= h2 - l2) x = h1 >= l1 ? random(l1, h1) : Math.max(spread, h1);
      else x = random(l2, h2);
    }
  } catch (e) {}
  return x;
}

// 拟人上滑：起止点随机，中间带弯曲，时长 300–700 毫秒
function humanSwipe(dur) {
  let y0 = Math.round(H * (CFG.swipeY[0] + random(-4, 4) / 100));
  let y1 = Math.round(H * (CFG.swipeY[1] + random(-3, 3) / 100));
  let x0 = swipeX(y0, y1, 130); // 弯曲最多偏 80、终点最多偏 70，再留一点余量
  let x1 = x0 + random(-70, 70);
  let bow = random(-80, 80);
  let ym = y0 + Math.round((y1 - y0) * (0.35 + random(0, 20) / 100));
  return gesture(dur || rnd(CFG.swipeMs), [x0, y0], [x0 + bow, ym], [x1, y1]);
}

function findOneText(re) {
  return textMatches(re).findOnce() || descMatches(re).findOnce();
}

// 用昵称（不带点赞数，点赞数会一直变）判断是不是换了直播间
let headerDesc = (timeout) => { let h = anyHeader(timeout || 800); return h ? headerNick(h) : ""; };

// 翻到下一个直播间。先用拟人的弯曲上滑；没换房间就用 ViewPager 的无障碍翻页动作，再不行用直线上滑。
// 用顶部条的昵称判断是否真的换了直播间
function nextLive(sw, pg) {
  let before = headerDesc(2500);
  humanSwipe(sw);
  sleep(pg || random(2000, 3000)); // 等直播间加载
  let after = headerDesc(1500);
  let moved = true;
  if (before && after === before) {
    log("弯曲上滑没换房间，改用无障碍翻页");
    let pager = className("androidx.viewpager.widget.ViewPager").scrollable(true).findOnce();
    if (!(pager && pager.scrollForward())) {
      let sx = swipeX(H * CFG.swipeY[0], H * CFG.swipeY[1], 40);
      swipe(sx, H * CFG.swipeY[0], sx, H * CFG.swipeY[1], random(180, 300));
    }
    sleep(random(2000, 3000));
    if (headerDesc(1500) === before) moved = false; // 两种办法都没换房间：可能被什么盖住了（2.18）
  }
  return moved;
}

// ---------------- 网络检测 ----------------
// 请求一个网址，5 秒超时。拿到任何 HTTP 响应（哪怕 403）都说明能连上
function urlOk(url, ms) {
  let ok = false;
  let t = threads.start(function () {
    try { let r = http.get(url, { headers: { "Cache-Control": "no-cache" } }); ok = !!r && r.statusCode > 0; } catch (e) { ok = false; }
  });
  t.join(ms || CFG.netTimeoutMs);
  if (t.isAlive()) { t.interrupt(); ok = false; }
  return ok;
}
// 系统层面有没有联网（Wi-Fi / 流量都关了时直接是 false）；读不到就当作有，交给网址检测判断
function sysOnline() {
  try {
    let ni = context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE).getActiveNetworkInfo();
    return !!(ni && ni.isConnected());
  } catch (e) { return true; }
}
// "ok" = TikTok 能连上；"vpn" = 普通网站能开、TikTok 不能（VPN 断了）；"nonet" = 都打不开或系统显示没联网
function netState(ms) {
  if (!sysOnline()) return "nonet";
  if (urlOk(CFG.netUrl, ms)) return "ok";
  return urlOk(CFG.plainUrl, ms) ? "vpn" : "nonet";
}

// 无障碍服务是否可用（被系统关掉时脚本会完全不动）。读不到 auto.service 时退回查系统设置里的开关
function accOk() {
  try { let sv = auto.service; if (sv !== undefined) return sv != null; } catch (e) {}
  try {
    let v = android.provider.Settings.Secure.getString(context.getContentResolver(), "enabled_accessibility_services");
    return !!v && String(v).indexOf(context.getPackageName() + "/") >= 0;
  } catch (e) { return true; }
}

// ---------------- 悬浮窗（2.15，v4.7 定稿） ----------------
// 依据：floaty-mock.html（定稿设计稿）。运行中 3 秒不碰缩成悬浮球，点球展开；停止和出问题时保持展开。
// 外观全部用代码画在一张位图上（渐变、光晕、投影都能画），再贴到悬浮窗里；触摸在窗口上做命中判断。
// 不用 AutoX 的 canvas 控件：它依赖 TextureView，悬浮窗不一定开硬件加速；位图方案不依赖这个。
let dp = (v) => Math.round(v * context.getResources().getDisplayMetrics().density);
let C = (s) => android.graphics.Color.parseColor(s) | 0;
// ARGB：把颜色 c 的透明度换成 a（0–1）。注意 Paint.setColor 在安卓 10 多了 long 重载，Rhino 会选错，所以统一走 setCol
let alphaC = (c, a) => (((Math.round(a * 255) & 255) << 24) | (c & 0xFFFFFF)) | 0;
let lerpC = (c1, c2, t) => {
  let ch = (s) => Math.round(((c1 >>> s) & 255) + ((((c2 >>> s) & 255) - ((c1 >>> s) & 255)) * t));
  return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) | 0;
};
let AG = android.graphics, GD = AG.drawable.GradientDrawable;
let setCol = (p, c) => p["setColor(int)"](c | 0);

// 品牌色和三种状态色（都是渐变，从亮到深）
let BRAND = { body: C("#2E2A39"), hi: C("#4a4359"), lo: C("#16121e"), violet: C("#B78BFF"), icon: C("#efeaff"), mute: C("#a9a3b8") };
let TONE = {
  run: { a: C("#5CFFB8"), b: C("#12D98A"), glow: alphaC(C("#2EF0A0"), 0.55) },
  stop: { a: C("#E4E1EC"), b: C("#9E99AD"), glow: 0 },
  alert: { a: C("#FF8FA0"), b: C("#FF3B5C"), glow: alphaC(C("#FF4664"), 0.6) },
};
// 出问题时的原因和处理办法（来自定稿设计稿）。btn = 卡片里的按钮文字
let ALERT = {
  halt: { t: "需验证", h: "TikTok 弹出了验证窗口。请在屏幕上完成验证，然后点 ▶ 继续。" },
  vpn: { t: "VPN 断开", h: "TikTok 连不上。请打开 VPN 并连接，连上后会自动继续。", btn: "重试" },
  nonet: { t: "无网络", h: "手机没有联网。请打开 Wi-Fi 或流量，恢复后会自动继续。", btn: "重试" },
  nolive: { t: "进不了直播", h: "网络正常，但连续 3 次进不了直播间。请手动打开 TikTok 的 LIVE 页面，然后点 ▶ 继续。" },
  notk: { t: "进不了直播", h: "TikTok 没能重新打开。请手动打开 TikTok 的 LIVE 页面，然后点 ▶ 继续。" },
  vfreq: { t: "验证太频繁", h: "TikTok 频繁弹出验证，继续跑容易被限制。建议先休息 10–30 分钟，或者手动完成验证后点 ▶ 继续。" },
  noacc: { t: "无障碍关闭", h: "系统关掉了「主播采集」的无障碍权限，程序没法操作 TikTok。", btn: "去设置打开" },
};

let win = floaty.window(
  <frame id="root" w="100" h="60">
    <img id="pic" w="*" h="*" scaleType="fitXY"/>
  </frame>
);

// ---- 状态 ----
let uiState = "pause"; // run | recover | pause | rest | vpn | nonet | halt | nolive | notk | noacc
let collapsed = false, dragging = false, asking = false, helpOpen = true, askKind = "quit"; // askKind：quit 退出采集 / clear 清空记录
let lastTouch = 0, restEnd = 0, retryNow = false;
let store = storages.create("live_id_grabber");
let pos = store.get("winPos", { side: "R", y: Math.round(H * 0.3) }); // side = 吸附在哪一边；y = 悬浮窗（胶囊 / 球）上沿的屏幕坐标
let flashText = "", flashUntil = 0, copyOkUntil = 0, bumpT0 = 0, doneT0 = 0, ppT0 = 0, ppPlay = true;
// 进度环：一圈 = 代码处理一个直播间的一轮。每轮开始时代码已经定好各步骤的时长（startCycle），环按这个总时长匀速走；
// 读到用户名并保存时 ringDone(true) 立刻补满、闪一下、数字跳一下；没读到（跳过）ringDone(false)，环平滑退回 0。环不会停在中途等待。
let ring = { mode: "idle", t0: 0, total: 8000, drainT0: 0, drainFrom: 0, pseudo: false };

// 实际显示的状态：暂停时只保留“需要人处理”的警告，其他一律显示已暂停
function effState() {
  if (running) return uiState === "pause" ? "run" : uiState;
  return /^(halt|nolive|notk|vfreq)$/.test(uiState) ? uiState : "pause";
}
function kindOf() {
  let es = effState();
  if (es === "run" || es === "recover") return "run";
  if (es === "rest") return "rest";
  if (es === "pause") return "stop";
  return "alert";
}
let toneOf = (k) => (k === "alert" ? TONE.alert : k === "stop" ? TONE.stop : TONE.run);

function startCycle(totalMs) { ring = { mode: "cycle", t0: android.os.SystemClock.uptimeMillis(), total: Math.max(1500, totalMs), drainT0: 0, drainFrom: 0, pseudo: false }; }
function ringDone(saved) {
  let now = android.os.SystemClock.uptimeMillis();
  if (saved) { ring.mode = "full"; doneT0 = now; bumpT0 = now; }
  else if (ring.mode === "cycle") { ring.mode = "drain"; ring.drainFrom = Math.min((now - ring.t0) / ring.total, 1); ring.drainT0 = now; ring.pseudo = false; }
}
function ringP(now) {
  if (ring.mode === "full") return 1;
  if (ring.mode === "cycle") {
    let e = now - ring.t0;
    if (e >= ring.total + 300) { ring.mode = "drain"; ring.drainFrom = 1; ring.drainT0 = now; ring.pseudo = true; return 1; } // 这一轮比计划的久（例如在退避）：平滑退回再重新走，不停在满圈
    return Math.min(e / ring.total, 1);
  }
  if (ring.mode === "drain") {
    let f = (now - ring.drainT0) / 350;
    if (f >= 1) { if (ring.pseudo) { ring.mode = "cycle"; ring.t0 = now; ring.pseudo = false; return 0; } ring.mode = "idle"; return 0; }
    return ring.drainFrom * (1 - f * f * (3 - 2 * f));
  }
  return 0;
}

// ---- 画笔（只建一次） ----
function mkPaint() { let p = new AG.Paint(); p.setAntiAlias(true); return p; }
let pFill = mkPaint(), pStroke = mkPaint(), pText = mkPaint(), pUi = mkPaint(), pNum = mkPaint();
pStroke.setStyle(AG.Paint.Style.STROKE);
pStroke.setStrokeCap(AG.Paint.Cap.ROUND); pStroke.setStrokeJoin(AG.Paint.Join.ROUND);
pNum.setTextAlign(AG.Paint.Align.CENTER);
// 数字用圆体粗体。安卓上没有 Nunito，字体文件打包进 APK 又没法热更新，所以退回系统自带的最粗字体
try { pNum.setTypeface(AG.Typeface.create("sans-serif-black", 0)); } catch (e) { pNum.setTypeface(AG.Typeface.DEFAULT_BOLD); }
pUi.setTypeface(AG.Typeface.DEFAULT);
// 每一块各用各的渐变对象（v4.7 共用一个对象，胶囊把渐变中心设成左上角，球的光晕没重设，结果只有左上角亮）
let gdHalo = new GD(), gdBody = new GD(), gdRefl = new GD(), gdGloss = new GD(), gdCap = new GD(), gdHelp = new GD();
let rectF = new AG.RectF(), pathP = new AG.Path();

// 圆弧渐变：把圆弧切成小段，每段按“左上 → 右下”的对角线位置取色
function gradArc(cv, cx, cy, r, a0, sweep, ca, cb, sw, glowC) {
  rectF.set(cx - r, cy - r, cx + r, cy + r);
  pStroke.setStrokeCap(AG.Paint.Cap.BUTT);
  if (glowC) { setCol(pStroke, glowC); pStroke.setStrokeWidth(sw + dp(3)); cv.drawArc(rectF, a0, sweep, false, pStroke); } // 光晕整圈只画一次，不会在分段之间留暗缝
  pStroke.setStrokeWidth(sw);
  let n = Math.max(1, Math.ceil(Math.abs(sweep) / 10));
  for (let i = 0; i < n; i++) {
    let s0 = a0 + sweep * i / n, ds = sweep / n, mid = (s0 + ds / 2) * Math.PI / 180;
    let t = ((Math.cos(mid) + Math.sin(mid)) / Math.SQRT2 + 1) / 2;
    setCol(pStroke, lerpC(ca, cb, t));
    cv.drawArc(rectF, s0, ds + 2, false, pStroke); // 每段多画 2°，相邻两段叠在一起
  }
  pStroke.setStrokeCap(AG.Paint.Cap.ROUND);
}
function dot(cv, x, y, r, c) { pFill.setStyle(AG.Paint.Style.FILL); setCol(pFill, c); cv.drawCircle(x, y, r, pFill); }
// 软阴影：几层逐渐变大的半透明深色形状叠起来
function softShadow(cv, l, t, r, b, rad, dy, a) {
  pFill.setStyle(AG.Paint.Style.FILL);
  for (let i = 0; i < 5; i++) {
    let g = i * dp(1.6);
    setCol(pFill, alphaC(0, a * (1 - i / 5.5)));
    rectF.set(l - g, t - g + dy, r + g, b + g + dy);
    cv.drawRoundRect(rectF, rad + g, rad + g, pFill);
  }
}
// 圆润粗体数字：白 → 浅紫的竖向渐变（分三段裁剪来画），带一点投影
function gradText(cv, str, cx, cy, size, c1, c2, c3, a) {
  pNum.setTextSize(size);
  let fm = pNum.getFontMetrics(), base = cy - (fm.ascent + fm.descent) / 2, top = base + fm.ascent, h = fm.descent - fm.ascent;
  let hw = pNum.measureText(str) / 2 + dp(4);
  pNum.setStyle(AG.Paint.Style.FILL);
  setCol(pNum, alphaC(0, 0.55 * a)); cv.drawText(str, cx, base + dp(1), pNum);
  let bands = [[0, 0.45, c1], [0.45, 0.8, c2], [0.8, 1.01, c3]];
  for (let i = 0; i < 3; i++) {
    cv.save();
    cv.clipRect(cx - hw, top + h * bands[i][0], cx + hw, top + h * bands[i][1]);
    setCol(pNum, alphaC(bands[i][2], a)); cv.drawText(str, cx, base, pNum);
    cv.restore();
  }
}
function ease(t) { return t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t); }
let breathe = (now, period) => 0.5 - 0.5 * Math.cos((now % period) / period * 2 * Math.PI);

// ---- 图标（24 × 24 坐标系，和设计稿一致） ----
function iconAt(cv, cx, cy, size, fn) { cv.save(); cv.translate(cx - size / 2, cy - size / 2); cv.scale(size / 24, size / 24); fn(); cv.restore(); }
function strokeIcon(cv, color, sw, build) {
  pathP.reset(); build(pathP);
  pStroke.setStyle(AG.Paint.Style.STROKE); pStroke.setStrokeWidth(sw); pStroke.setStrokeCap(AG.Paint.Cap.ROUND); pStroke.setStrokeJoin(AG.Paint.Join.ROUND);
  setCol(pStroke, color); cv.drawPath(pathP, pStroke);
}
let ICON = {
  pause: (cv, c) => { pFill.setStyle(AG.Paint.Style.FILL); setCol(pFill, c); rectF.set(14, 4, 18, 20); cv.drawRoundRect(rectF, 1, 1, pFill); rectF.set(6, 4, 10, 20); cv.drawRoundRect(rectF, 1, 1, pFill); },
  play: (cv, c) => { pathP.reset(); pathP.moveTo(7, 4); pathP.lineTo(20, 12); pathP.lineTo(7, 20); pathP.close(); pFill.setStyle(AG.Paint.Style.FILL); setCol(pFill, c); cv.drawPath(pathP, pFill); },
  copy: (cv, c) => strokeIcon(cv, c, 2, (p) => {
    p.addRoundRect(new AG.RectF(8, 8, 22, 22), 2, 2, AG.Path.Direction.CW);
    p.moveTo(4, 16); p.cubicTo(2.9, 16, 2, 15.1, 2, 14); p.lineTo(2, 4); p.cubicTo(2, 2.9, 2.9, 2, 4, 2); p.lineTo(14, 2); p.cubicTo(15.1, 2, 16, 2.9, 16, 4);
  }),
  share: (cv, c) => strokeIcon(cv, c, 2, (p) => {
    p.moveTo(4, 12); p.lineTo(4, 20); p.quadTo(4, 22, 6, 22); p.lineTo(18, 22); p.quadTo(20, 22, 20, 20); p.lineTo(20, 12);
    p.moveTo(16, 6); p.lineTo(12, 2); p.lineTo(8, 6); p.moveTo(12, 2); p.lineTo(12, 15);
  }),
  close: (cv, c) => strokeIcon(cv, c, 2, (p) => { p.moveTo(18, 6); p.lineTo(6, 18); p.moveTo(6, 6); p.lineTo(18, 18); }),
  check: (cv, c) => strokeIcon(cv, c, 2, (p) => { p.moveTo(20, 6); p.lineTo(9, 17); p.lineTo(4, 12); }),
};

// ---- 版面：算出这一帧窗口多大、各个按钮在哪（按钮位置同时用于触摸判断）----
let PAD = dp(10), ORB = dp(58), CAPH = dp(44), HELPW = dp(232);
let helpCache = { key: "", lines: [] };
function wrapText(str, maxW) {
  let out = [], cur = "", units = str.match(/[A-Za-z0-9._'\-]+|[\s\S]/g) || [];
  for (let i = 0; i < units.length; i++) {
    let u = units[i];
    if (pUi.measureText(cur + u) > maxW && cur && !/^[，。！？、；：）」』”’,.!?;:)]$/.test(u)) { out.push(cur); cur = u; } else cur += u;
  }
  if (cur) out.push(cur);
  return out;
}
function layout(now) {
  let kind = kindOf(), es = effState(), m = { kind: kind, es: es };
  m.orb = collapsed && !asking && (kind === "run" || kind === "rest");
  m.flash = now < flashUntil;
  m.topExtra = m.flash ? dp(28) : 0;
  m.tipW = 0;
  if (m.flash) { pUi.setTextSize(dp(11)); m.tipW = pUi.measureText(flashText) + dp(18); }
  let al = kind === "alert" ? ALERT[es] : null;
  m.al = al;
  pUi.setTextSize(dp(12));
  if (m.orb) { m.cw = ORB; m.ch = ORB; }
  else {
    let padL = dp(4), padR = dp(5), r = {}, x = padL;
    if (asking) {
      let t = askKind === "clear" ? "清空 " + seen.size + " 个记录？" : "退出采集？";
      m.ask = { text: t, yes: askKind === "clear" ? "清空" : "退出" };
      let tw = pUi.measureText(t), yw = pUi.measureText(m.ask.yes) + dp(20), nw = pUi.measureText("取消") + dp(20);
      r.askText = { x: padL + dp(6), w: tw };
      let yx = padL + dp(6) + tw + dp(6);
      r.yes = { l: yx, t: dp(10), r: yx + yw, b: CAPH - dp(10) };
      r.no = { l: yx + yw + dp(6), t: dp(10), r: yx + yw + dp(6) + nw, b: CAPH - dp(10) };
      m.cw = r.no.r + dp(6) + padR;
    } else {
      r.pp = { cx: x + dp(18), cy: CAPH / 2, r: dp(18) }; x += dp(36);
      let label, valW;
      if (al) { label = al.t; valW = pUi.measureText(label) + dp(5) + dp(9) + dp(18); }
      else if (kind === "rest") { label = "休息 " + restClock(); pNum.setTextSize(dp(17)); valW = Math.max(dp(50), pNum.measureText(label) + dp(18)); }
      else { label = String(seen.size); pNum.setTextSize(dp(17)); valW = Math.max(dp(50), pNum.measureText(label) + dp(18)); }
      m.label = label;
      r.val = { l: x, t: 0, r: x + valW, b: CAPH }; x += valW + dp(2);
      r.sep = x; x += 1 + dp(2);
      r.copy = { cx: x + dp(17), cy: CAPH / 2, r: dp(17) }; x += dp(34);
      r.share = { cx: x + dp(17), cy: CAPH / 2, r: dp(17) }; x += dp(34);
      r.close = { cx: x + dp(17), cy: CAPH / 2, r: dp(17) }; x += dp(34);
      m.cw = x + padR;
    }
    m.r = r; m.ch = CAPH;
  }
  // 出问题时胶囊下面的处理卡片
  m.help = !!(al && helpOpen && !m.orb && !asking);
  m.helpH = 0;
  if (m.help) {
    pUi.setTextSize(dp(12));
    let key = es + "|" + al.t;
    if (helpCache.key !== key) { helpCache = { key: key, lines: wrapText(al.t + "　" + al.h, HELPW - dp(24)) }; }
    m.lines = helpCache.lines;
    m.lh = dp(18.6);
    m.helpH = dp(10) * 2 + m.lines.length * m.lh + (al.btn ? dp(8) + dp(26) : 0);
  }
  m.rootW = Math.max(m.cw, m.help ? HELPW : 0, m.tipW) + 2 * PAD;
  m.rootH = PAD + m.topExtra + m.ch + (m.help ? dp(6) + m.helpH : 0) + PAD;
  m.cx = pos.side === "L" ? PAD : m.rootW - PAD - m.cw; // 胶囊 / 球在窗口里的左边界（靠哪边就贴哪边）
  m.cy = PAD + m.topExtra;
  return m;
}
function restClock() {
  let s = Math.max(0, Math.ceil((restEnd - android.os.SystemClock.uptimeMillis()) / 1000));
  return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
}

// ---- 画 ----
let bmp = null, bcv = null, bw = 0, bh = 0, curM = null;
function drawOrb(cv, m, now, tone) {
  let S = ORB, ox = m.cx, oy = m.cy, cx = ox + S / 2, cy = oy + S / 2, kind = m.kind;
  // 光晕（慢呼吸）：运行 2.6 秒一次，休息中 4.5 秒，出问题 1.1 秒；停止时没有
  if (tone.glow) {
    let f = breathe(now, kind === "rest" ? 4500 : 2600), rr = (S / 2 + dp(9)) * (0.82 + 0.18 * f);
    gdHalo.setShape(GD.OVAL); gdHalo.setGradientType(GD.RADIAL_GRADIENT); gdHalo.setGradientCenter(0.5, 0.5); gdHalo.setGradientRadius(rr); // 中心在球正中
    gdHalo.setColors([alphaC(tone.glow, 0.45 + 0.55 * f), 0]);
    gdHalo.setBounds(Math.round(cx - rr), Math.round(cy - rr), Math.round(cx + rr), Math.round(cy + rr)); gdHalo.draw(cv);
  }
  let bi = S * 0.07, bl = ox + bi, bt = oy + bi, bs = S - 2 * bi;
  softShadow(cv, bl, bt, bl + bs, bt + bs, bs / 2, dp(4), 0.2);
  // 玻璃球：左上到右下的径向渐变 + 底部反射状态色 + 顶部白色高光
  gdBody.setShape(GD.OVAL); gdBody.setGradientType(GD.RADIAL_GRADIENT); gdBody.setGradientCenter(0.34, 0.26); gdBody.setGradientRadius(bs * 0.85);
  gdBody.setColors([C("#5b5470"), BRAND.body, C("#100d17")]); gdBody.setBounds(Math.round(bl), Math.round(bt), Math.round(bl + bs), Math.round(bt + bs)); gdBody.draw(cv);
  gdRefl.setShape(GD.OVAL); gdRefl.setGradientType(GD.RADIAL_GRADIENT); gdRefl.setGradientCenter(0.5, 1.15); gdRefl.setGradientRadius(bs * 0.62);
  gdRefl.setColors([alphaC(tone.b, 0.38), 0]); gdRefl.setBounds(Math.round(bl), Math.round(bt), Math.round(bl + bs), Math.round(bt + bs)); gdRefl.draw(cv);
  gdGloss.setShape(GD.OVAL); gdGloss.setGradientType(GD.LINEAR_GRADIENT); gdGloss.setOrientation(GD.Orientation.TOP_BOTTOM);
  gdGloss.setColors([alphaC(C("#FFFFFF"), 0.42), 0]);
  gdGloss.setBounds(Math.round(ox + S * 0.22), Math.round(oy + S * 0.12), Math.round(ox + S * 0.68), Math.round(oy + S * 0.38)); gdGloss.draw(cv);
  // 外圈进度环
  let rr = S * 0.42, sw = S * 0.05;
  pStroke.setStyle(AG.Paint.Style.STROKE); pStroke.setStrokeWidth(sw); setCol(pStroke, alphaC(C("#FFFFFF"), 0.12)); cv.drawCircle(cx, cy, rr, pStroke);
  if (kind === "run") {
    let p = ringP(now);
    if (p > 0.004) {
      gradArc(cv, cx, cy, rr, -90, 360 * p, tone.a, tone.b, sw, alphaC(tone.glow, 0.35));
      let ang = (-90 + 360 * p) * Math.PI / 180, hx = cx + rr * Math.cos(ang), hy = cy + rr * Math.sin(ang);
      dot(cv, hx, hy, dp(4), alphaC(tone.a, 0.35)); dot(cv, hx, hy, S * 0.032 + dp(0.6), C("#FFFFFF"));
    }
  } else gradArc(cv, cx, cy, rr, -90, 359.9, tone.a, tone.b, sw, 0); // 停止 / 出问题 / 休息中：满圈，没有白点
  // 完成时外圈闪一下
  let df = (now - doneT0) / 600;
  if (df >= 0 && df < 1) {
    let rad = S / 2 * (0.98 + 0.17 * df);
    pStroke.setStyle(AG.Paint.Style.STROKE); pStroke.setStrokeWidth(dp(2)); setCol(pStroke, alphaC(tone.a, 0.9 * (1 - df))); cv.drawCircle(cx, cy, rad, pStroke);
  }
  // 中间的数字：不带“个”；出问题时是红色的“!”
  let bf = (now - bumpT0) / 400, sc = bf >= 0 && bf < 1 ? 1 + 0.14 * Math.sin(Math.PI * Math.min(1, bf * 1.6)) : 1;
  cv.save(); cv.scale(sc, sc, cx, cy);
  if (kind === "alert") gradText(cv, "!", cx, cy, dp(22), C("#FFFFFF"), tone.a, tone.a, 1);
  else gradText(cv, String(seen.size), cx, cy, dp(16), C("#FFFFFF"), C("#ece6ff"), C("#c9bdf0"), kind === "stop" ? 0.7 : 1);
  cv.restore();
}
function drawCap(cv, m, now, tone) {
  let x0 = m.cx, y0 = m.cy, w = m.cw, h = CAPH, r = m.r, kind = m.kind;
  softShadow(cv, x0, y0, x0 + w, y0 + h, h / 2, dp(6), 0.22);
  gdCap.setShape(GD.RECTANGLE); gdCap.setCornerRadius(h / 2); gdCap.setGradientType(GD.RADIAL_GRADIENT); gdCap.setGradientCenter(0.3, 0); gdCap.setGradientRadius(w * 0.95);
  gdCap.setColors([BRAND.hi, BRAND.body, BRAND.lo]); gdCap.setBounds(Math.round(x0), Math.round(y0), Math.round(x0 + w), Math.round(y0 + h)); gdCap.draw(cv);
  // 玻璃质感：上沿一条细高光
  pStroke.setStyle(AG.Paint.Style.STROKE); pStroke.setStrokeWidth(dp(1)); setCol(pStroke, alphaC(C("#FFFFFF"), 0.08));
  rectF.set(x0 + dp(1), y0 + dp(1), x0 + w - dp(1), y0 + h - dp(1)); cv.drawRoundRect(rectF, h / 2, h / 2, pStroke);
  let midY = y0 + h / 2;
  if (asking) {
    pUi.setTextSize(dp(12)); pUi.setStyle(AG.Paint.Style.FILL); setCol(pUi, C("#FFFFFF"));
    let fm = pUi.getFontMetrics(), base = midY - (fm.ascent + fm.descent) / 2;
    cv.drawText(m.ask.text, x0 + r.askText.x, base, pUi);
    [["yes", m.ask.yes, alphaC(TONE.alert.b, 1), C("#FFFFFF")], ["no", "取消", alphaC(C("#FFFFFF"), 0.14), C("#FFFFFF")]].forEach((b) => {
      let q = r[b[0]]; setCol(pFill, b[2]); pFill.setStyle(AG.Paint.Style.FILL);
      rectF.set(x0 + q.l, y0 + q.t, x0 + q.r, y0 + q.b); cv.drawRoundRect(rectF, dp(12), dp(12), pFill);
      setCol(pUi, b[3]); pUi.setTextAlign(AG.Paint.Align.CENTER); cv.drawText(b[1], x0 + (q.l + q.r) / 2, base, pUi); pUi.setTextAlign(AG.Paint.Align.LEFT);
    });
    return;
  }
  // 播放 / 暂停：外圈是状态色渐变的细环；切换时图标旋转缩放（约 200ms）
  let pcx = x0 + r.pp.cx, pr = dp(15.5);
  pStroke.setStyle(AG.Paint.Style.STROKE); pStroke.setStrokeWidth(dp(3)); setCol(pStroke, alphaC(C("#FFFFFF"), 0.12)); cv.drawCircle(pcx, midY, pr, pStroke);
  gradArc(cv, pcx, midY, pr, -90, 359.9, tone.a, tone.b, dp(3), 0);
  let wantPlay = !(kind === "run" || kind === "rest");
  if (wantPlay !== ppPlay) { ppPlay = wantPlay; ppT0 = now; }
  let f = ease((now - ppT0) / 220), isz = dp(14), pcol = BRAND.icon;
  let drawIc = (fn, s, rot, al) => { cv.save(); cv.translate(pcx, midY); cv.rotate(rot); cv.translate(-isz * s / 2, -isz * s / 2); cv.scale(isz * s / 24, isz * s / 24); fn(cv, alphaC(pcol, al)); cv.restore(); };
  if (f >= 1) drawIc(ppPlay ? ICON.play : ICON.pause, 1, 0, 1);
  else {
    drawIc(ppPlay ? ICON.pause : ICON.play, 1 - 0.6 * f, ppPlay ? 90 * f : -90 * f, 1 - f);   // 旧的转着缩小淡出
    drawIc(ppPlay ? ICON.play : ICON.pause, 0.4 + 0.6 * f, ppPlay ? -90 * (1 - f) : 90 * (1 - f), f); // 新的转着放大淡入
  }
  // 数量（出问题时是红字原因 + 小箭头；休息中是倒计时）
  let vx = x0 + (r.val.l + r.val.r) / 2;
  if (m.al) {
    pUi.setTextSize(dp(12)); pUi.setStyle(AG.Paint.Style.FILL); setCol(pUi, tone.a); pUi.setTextAlign(AG.Paint.Align.LEFT);
    let fm = pUi.getFontMetrics(), base = midY - (fm.ascent + fm.descent) / 2, tw = pUi.measureText(m.al.t);
    let sx = x0 + r.val.l + ((r.val.r - r.val.l) - (tw + dp(14))) / 2;
    cv.drawText(m.al.t, sx, base, pUi);
    let ax = sx + tw + dp(9), ay = midY + (helpOpen ? dp(1) : -dp(1)), d = helpOpen ? -1 : 1;
    strokeIcon(cv, tone.a, dp(1.5), (p) => { p.moveTo(ax - dp(3), ay - d * dp(1.5)); p.lineTo(ax, ay + d * dp(1.5)); p.lineTo(ax + dp(3), ay - d * dp(1.5)); });
  } else {
    let bf = (now - bumpT0) / 400, sc = bf >= 0 && bf < 1 ? 1 + 0.14 * Math.sin(Math.PI * Math.min(1, bf * 1.6)) : 1;
    cv.save(); cv.scale(sc, sc, vx, midY);
    gradText(cv, m.label, vx, midY, dp(17), C("#FFFFFF"), C("#efe8ff"), C("#d8ccff"), kind === "stop" ? 0.7 : 1);
    cv.restore();
  }
  pFill.setStyle(AG.Paint.Style.FILL); setCol(pFill, alphaC(C("#FFFFFF"), 0.14));
  cv.drawRect(x0 + r.sep, midY - dp(9), x0 + r.sep + 1, midY + dp(9), pFill);
  let ok = now < copyOkUntil;
  iconAt(cv, x0 + r.copy.cx, midY, dp(16), () => (ok ? ICON.check(cv, TONE.run.a) : ICON.copy(cv, BRAND.icon)));
  iconAt(cv, x0 + r.share.cx, midY, dp(16), () => ICON.share(cv, BRAND.icon));
  iconAt(cv, x0 + r.close.cx, midY, dp(16), () => ICON.close(cv, BRAND.mute));
}
function drawHelp(cv, m, now, tone) {
  let hx = pos.side === "L" ? PAD : m.rootW - PAD - HELPW, hy = m.cy + CAPH + dp(6);
  softShadow(cv, hx, hy, hx + HELPW, hy + m.helpH, dp(14), dp(6), 0.2);
  gdHelp.setShape(GD.RECTANGLE); gdHelp.setCornerRadius(dp(14)); gdHelp.setGradientType(GD.RADIAL_GRADIENT); gdHelp.setGradientCenter(0.3, 0); gdHelp.setGradientRadius(HELPW * 0.95);
  gdHelp.setColors([BRAND.hi, BRAND.body, BRAND.lo]); gdHelp.setBounds(Math.round(hx), Math.round(hy), Math.round(hx + HELPW), Math.round(hy + m.helpH)); gdHelp.draw(cv);
  pUi.setTextSize(dp(12)); pUi.setStyle(AG.Paint.Style.FILL); pUi.setTextAlign(AG.Paint.Align.LEFT);
  let fm = pUi.getFontMetrics(), ty = hy + dp(10), tx = hx + dp(12), reasonLen = m.al.t.length;
  for (let i = 0; i < m.lines.length; i++) {
    let base = ty + i * m.lh + (m.lh - (fm.descent - fm.ascent)) / 2 - fm.ascent, ln = m.lines[i];
    if (i === 0) {
      let a = ln.substring(0, reasonLen), b = ln.substring(reasonLen);
      pUi.setFakeBoldText(true); setCol(pUi, tone.a); cv.drawText(a, tx, base, pUi); pUi.setFakeBoldText(false);
      setCol(pUi, C("#FFFFFF")); cv.drawText(b, tx + pUi.measureText(a), base, pUi);
    } else { setCol(pUi, C("#FFFFFF")); cv.drawText(ln, tx, base, pUi); }
  }
  if (m.al.btn) {
    let bw2 = pUi.measureText(m.al.btn) + dp(24), by = ty + m.lines.length * m.lh + dp(8);
    m.helpBtn = { l: hx + dp(12), t: by, r: hx + dp(12) + bw2, b: by + dp(26) };
    pStroke.setStyle(AG.Paint.Style.STROKE); pStroke.setStrokeWidth(dp(1)); setCol(pStroke, alphaC(C("#FFFFFF"), 0.35));
    rectF.set(m.helpBtn.l, m.helpBtn.t, m.helpBtn.r, m.helpBtn.b); cv.drawRoundRect(rectF, dp(13), dp(13), pStroke);
    setCol(pUi, C("#FFFFFF")); pUi.setTextAlign(AG.Paint.Align.CENTER);
    cv.drawText(m.al.btn, (m.helpBtn.l + m.helpBtn.r) / 2, (m.helpBtn.t + m.helpBtn.b) / 2 - (fm.ascent + fm.descent) / 2, pUi); pUi.setTextAlign(AG.Paint.Align.LEFT);
  } else m.helpBtn = null;
}
function drawFlash(cv, m) {
  pUi.setTextSize(dp(11)); let tw = pUi.measureText(flashText), bw2 = tw + dp(18), bh2 = dp(22);
  let fx = bw2 > m.cw ? (pos.side === "L" ? m.cx : m.cx + m.cw - bw2) : m.cx + (m.cw - bw2) / 2, fy = m.cy - dp(8) - bh2; // 比悬浮窗宽时靠屏幕边缘那一侧对齐
  pFill.setStyle(AG.Paint.Style.FILL); setCol(pFill, BRAND.body); rectF.set(fx, fy, fx + bw2, fy + bh2); cv.drawRoundRect(rectF, dp(9), dp(9), pFill);
  setCol(pUi, C("#FFFFFF")); pUi.setStyle(AG.Paint.Style.FILL); pUi.setTextAlign(AG.Paint.Align.LEFT);
  let fm = pUi.getFontMetrics(); cv.drawText(flashText, fx + dp(9), fy + bh2 / 2 - (fm.ascent + fm.descent) / 2, pUi);
}

let rootW = 0, rootH = 0;
function drawFrame() {
  let now = android.os.SystemClock.uptimeMillis();
  // 运行中（含休息中）3 秒不碰才缩成球；停止和出问题时一直保持展开
  let kind0 = kindOf();
  if (kind0 === "stop" || kind0 === "alert") collapsed = false;
  else if (!collapsed && !dragging && !asking && now - lastTouch > 3000) collapsed = true;
  let m = layout(now);
  curM = m;
  let tone = toneOf(m.kind);
  if (m.rootW !== rootW || m.rootH !== rootH || !bmp) {
    rootW = m.rootW; rootH = m.rootH;
    bmp = AG.Bitmap.createBitmap(rootW, rootH, AG.Bitmap.Config.ARGB_8888); bcv = new AG.Canvas(bmp);
    let lp = win.root.getLayoutParams();
    if (lp) { lp.width = rootW; lp.height = rootH; win.root.setLayoutParams(lp); }
    win.pic.setImageBitmap(bmp);
    ui.post(placeWindow, 30);
  }
  bmp["eraseColor(int)"](0);
  if (m.orb) drawOrb(bcv, m, now, tone); else { drawCap(bcv, m, now, tone); if (m.help) drawHelp(bcv, m, now, tone); }
  if (m.flash) drawFlash(bcv, m);
  win.pic.invalidate();
}
// 帧率：有动画（环在走、光晕在呼吸、图标在变）时约 15 帧；静止时 4 帧。
// 音律条那版实测：每帧都刷新会让系统把无障碍服务解绑，所以窗口对无障碍隐藏，帧率也压低（见下面 setImportantForAccessibility）
function frameLoop() {
  try { drawFrame(); } catch (e) { if (!frameLoop.warned) { frameLoop.warned = true; log("悬浮窗绘制出错: " + e); } }
  let m = curM, busy = m && (m.kind === "run" || m.kind === "rest" || m.kind === "alert" || android.os.SystemClock.uptimeMillis() - lastTouch < 1500 || copyOkUntil > android.os.SystemClock.uptimeMillis());
  ui.post(frameLoop, busy ? 66 : 250);
}

// ---- 摆放、拖动和吸附 ----
let fw = () => win.root.getWidth(), fh = () => win.root.getHeight();
// 悬浮窗里的内容（胶囊 / 球 + 下面的卡片）不能停在顶部 18%（头像 / LIVE 区）和底部 13%（评论框）
let sbH = 0;
try { let rid = context.getResources().getIdentifier("status_bar_height", "dimen", "android"); if (rid > 0) sbH = context.getResources().getDimensionPixelSize(rid); } catch (e) {}
let zoneTop = () => Math.round(H * 0.18) - sbH, zoneBot = () => Math.round(H * 0.87) - sbH; // 窗口坐标 = 屏幕坐标 - 状态栏高度
function contentTop(rootY) { return rootY + PAD + (curM ? curM.topExtra : 0); }
function clampContentTop(cy) {
  let m = curM, below = m ? (m.cy - PAD - m.topExtra) + (m.ch) + (m.help ? dp(6) + m.helpH : 0) : CAPH;
  return Math.max(zoneTop(), Math.min(Math.round(cy), zoneBot() - below));
}
function placeWindow() {
  if (dragging || !curM) return;
  pos.y = clampContentTop(pos.y);
  win.setPosition(pos.side === "L" ? 0 : W - rootW, pos.y - PAD - curM.topExtra);
}
function snap() {
  if (!curM) return;
  let x0 = win.getX(), y0 = win.getY(), w = rootW;
  pos = { side: x0 + w / 2 < W / 2 ? "L" : "R", y: clampContentTop(contentTop(y0)) };
  try { store.put("winPos", pos); } catch (e) {}
  let x1 = pos.side === "L" ? 0 : W - w, y1 = pos.y - PAD - curM.topExtra;
  let va = android.animation.ValueAnimator.ofFloat(0, 1);
  va.setDuration(250);
  va.setInterpolator(new android.view.animation.DecelerateInterpolator());
  va.addUpdateListener(function (a) { let f = a.getAnimatedFraction(); win.setPosition(Math.round(x0 + (x1 - x0) * f), Math.round(y0 + (y1 - y0) * f)); });
  va.start();
}
// 点在哪：返回 "pp" / "val" / "copy" / "share" / "close" / "yes" / "no" / "help" / "orb" / "body" / null（窗口里的空白）
function hitTest(x, y) {
  let m = curM; if (!m) return null;
  let cx = x - m.cx, cy = y - m.cy;
  if (m.orb) return (cx >= 0 && cx <= ORB && cy >= 0 && cy <= ORB) ? "orb" : null;
  if (m.helpBtn && x >= m.helpBtn.l && x <= m.helpBtn.r && y >= m.helpBtn.t && y <= m.helpBtn.b) return "help";
  if (cy < 0 || cy > CAPH || cx < 0 || cx > m.cw) return null;
  let r = m.r;
  if (asking) {
    if (cx >= r.yes.l && cx <= r.yes.r) return "yes";
    if (cx >= r.no.l && cx <= r.no.r) return "no";
    return "body";
  }
  let near = (b) => Math.sqrt((cx - b.cx) * (cx - b.cx) + (cy - b.cy) * (cy - b.cy)) <= b.r + dp(4);
  if (near(r.pp)) return "pp";
  if (near(r.copy)) return "copy";
  if (near(r.share)) return "share";
  if (near(r.close)) return "close";
  if (cx >= r.val.l && cx <= r.val.r) return "val";
  return "body";
}
function onTap(what) {
  let now = android.os.SystemClock.uptimeMillis();
  lastTouch = now;
  if (what === "orb") { collapsed = false; }
  else if (what === "pp") togglePlay();
  else if (what === "val") { if (curM && curM.al) { helpOpen = !helpOpen; } }
  else if (what === "copy") doCopy();
  else if (what === "share") doShare();
  else if (what === "close") { askKind = "quit"; asking = true; }
  else if (what === "no") { asking = false; askKind = "quit"; }
  else if (what === "yes") {
    if (askKind === "clear") { asking = false; askKind = "quit"; clearRecords(); }
    else threads.start(function () { log("退出"); try { win.close(); } catch (e) {} exit(); });
  }
  else if (what === "help") helpAction();
  ui.post(drawFrame, 0);
}
// 按住胶囊任何位置（或球）拖动；没怎么移动就当作点了一下
function attachTouch() {
  let sx = 0, sy = 0, wx = 0, wy = 0, moved = false, down = null, lpSeq = 0, lpFired = false;
  let ME = android.view.MotionEvent;
  win.root.setOnTouchListener(function (v, e) {
    let a = e.getActionMasked();
    if (a === ME.ACTION_DOWN) {
      sx = e.getRawX(); sy = e.getRawY(); wx = win.getX(); wy = win.getY(); moved = false;
      down = hitTest(e.getX(), e.getY()); lastTouch = android.os.SystemClock.uptimeMillis();
      lpFired = false; let my = ++lpSeq; // 长按数字 0.6 秒：清空记录（出问题时数字位置是原因，不响应）
      if (down === "val" && curM && !curM.al && !asking) ui.post(function () { if (my === lpSeq && !moved && !dragging) { lpFired = true; askKind = "clear"; asking = true; lastTouch = android.os.SystemClock.uptimeMillis(); } }, 600);
      return down !== null; // 窗口空白处不拦截，让触摸穿透（窗口外面那圈透明区域不该挡住 TikTok）
    } else if (a === ME.ACTION_MOVE) {
      let dx = e.getRawX() - sx, dy = e.getRawY() - sy;
      // 胶囊上任何位置（包括按钮和红色提示文字）按住移动超过 8dp 都算拖动，和运行时的球一样；没怎么动才算点按钮
      if (!moved && Math.abs(dx) + Math.abs(dy) < dp(8)) return true;
      moved = true; dragging = true; lpSeq++; lastTouch = android.os.SystemClock.uptimeMillis();
      win.setPosition(Math.round(wx + dx), Math.round(wy + dy));
    } else if (a === ME.ACTION_UP || a === ME.ACTION_CANCEL) {
      let was = dragging; dragging = false; lpSeq++;
      if (lpFired) { lpFired = false; return true; } // 长按已经弹出确认条，抬手不当作点击
      if (was) snap();
      else if (a === ME.ACTION_UP && down) { if (hitTest(e.getX(), e.getY()) === down) onTap(down); }
      lastTouch = android.os.SystemClock.uptimeMillis();
    }
    return true;
  });
}

// ---- 动作 ----
function togglePlay() {
  let es = effState();
  if (es === "vpn" || es === "nonet" || es === "noacc") { retryNow = true; return; } // 这几种程序会自动继续，点 ▶ = 现在就重试
  running = !running;
  if (running) { relaunchFails = 0; liveFails = 0; if (uiState === "halt" || uiState === "nolive" || uiState === "notk" || uiState === "vfreq") uiState = "run"; }
  setState(running ? "run" : "pause");
  log(running ? "开始" : "暂停");
}
function helpAction() {
  let es = effState();
  if (es === "noacc") {
    try { let it = new android.content.Intent("android.settings.ACCESSIBILITY_SETTINGS"); it.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK); context.startActivity(it); }
    catch (e) { log("打开无障碍设置失败: " + e); }
  } else if (es === "vpn" || es === "nonet") retryNow = true;
}
let readNames = () => (files.exists(CFG.outFile) ? files.read(CFG.outFile).split("\n").map((l) => l.trim().replace(/^@+/, "")).filter((l) => l) : []);
// 复制：每行一个用户名放进剪贴板，图标变成绿色 ✓ 保持 1.5 秒，胶囊上方出现“已复制 N 个”。
// 这个提示画在悬浮窗自己身上，不用系统提示（荣耀会拦截 AutoX 的系统提示，实测）
function doCopy() {
  try {
    let names = readNames();
    setClip(names.join("\n"));
    let now = android.os.SystemClock.uptimeMillis();
    copyOkUntil = now + 1500; flashText = "已复制 " + names.length + " 个"; flashUntil = now + 1500;
    log("复制全部 " + names.length + " 个");
  } catch (e) { log("复制失败: " + e); }
}
// 分享：用安卓分享菜单发送 streamers.txt（可直接选微信）；文件分享不可用时退回分享纯文本
function doShare() {
  try {
    let I = android.content.Intent;
    if (!files.exists(CFG.outFile) || !readNames().length) { flashText = "还没有结果可分享"; flashUntil = android.os.SystemClock.uptimeMillis() + 1500; return; }
    let it = new I(I.ACTION_SEND), how = "文件";
    try {
      let uri = app.getUriForFile(CFG.outFile);
      it.setType("text/plain"); it.putExtra(I.EXTRA_STREAM, uri); it.addFlags(I.FLAG_GRANT_READ_URI_PERMISSION);
    } catch (e) {
      how = "文本"; log("文件分享不可用，改分享文本: " + e);
      it = new I(I.ACTION_SEND); it.setType("text/plain"); it.putExtra(I.EXTRA_TEXT, readNames().join("\n"));
    }
    let ch = I.createChooser(it, "分享主播列表");
    ch.addFlags(I.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(ch);
    log("分享（" + how + "）");
  } catch (e) { log("分享失败: " + e); }
}

// 清空记录：不真删。streamers.txt 改名为备份 streamers_年-月-日_时分.txt，再新建空的 streamers.txt；数量归 0，去重从头开始
function clearRecords() {
  threads.start(function () {
    try {
      let n = seen.size;
      if (!files.exists(CFG.outFile) || n === 0) { showTip("没有记录可清空"); return; }
      let d = new Date(), z = (v) => (v < 10 ? "0" : "") + v;
      let stamp = d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()) + "_" + z(d.getHours()) + z(d.getMinutes());
      let base = CFG.outFile.replace(/\.txt$/, ""), bak = base + "_" + stamp + ".txt";
      if (files.exists(bak)) bak = base + "_" + stamp + z(d.getSeconds()) + ".txt"; // 同一分钟清空两次，不覆盖
      files.move(CFG.outFile, bak);
      files.write(CFG.outFile, "");
      seen.clear(); count = 0;
      showTip("已清空，旧记录已备份", 3000);
      log("已清空 " + n + " 个记录，备份到 " + bak);
    } catch (e) { log("清空失败: " + e); showTip("清空失败"); }
  });
}

// ---- 状态切换（主循环调用）----
// st: run / recover / pause / vpn / nonet / halt / nolive / notk / noacc。警告状态写进日志（时间 + 原因）；“需验证”时手机振动并响一声
function setState(st, reason) {
  if (st !== uiState) {
    if (st === "recover") log("自动恢复中：" + (reason || ""));
    else if (ALERT[st]) log("⚠️ 状态：" + ALERT[st].t + (reason ? "（" + reason + "）" : ""));
    if (st === "halt" || st === "vfreq") alarm();
    if (ALERT[st]) helpOpen = true; // 出问题时自动展开，并弹出处理卡片
    lastTouch = android.os.SystemClock.uptimeMillis();
  }
  uiState = st;
}
// 悬浮窗上方短暂提示（画在悬浮窗自己身上，不用系统提示）
function showTip(text, ms) { flashText = text; flashUntil = android.os.SystemClock.uptimeMillis() + (ms || 2200); }
function render() { lastTouch = Math.max(lastTouch, 0); } // 数量直接从 seen.size 读，每帧都会刷新；这里留个空壳，兼容主循环里的调用
function alarm() {
  try { device.vibrate(800); } catch (e) {}
  try {
    let RM = android.media.RingtoneManager;
    let r = RM.getRingtone(context, RM.getDefaultUri(RM.TYPE_NOTIFICATION));
    if (r) r.play();
  } catch (e) { log("提示音失败: " + e); }
}
// 暂停并显示需要人处理的原因（需验证 / 进不了直播）
function haltWith(st, reason) {
  running = false;
  setState(st, reason);
}
// 休息中：数量的位置显示倒计时，环显示满圈，光晕慢呼吸
function setRest(ms) { restEnd = android.os.SystemClock.uptimeMillis() + ms; uiState = "rest"; }

ui.run(() => {
  // 悬浮窗不参与无障碍：画面每帧都在变，每变一下都会发无障碍事件，
  // 实测（音律条版）10–30 秒后系统会把所有无障碍服务解绑重连，脚本报 “enabled but not running”
  win.root.setImportantForAccessibility(4); // IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
  win.pic.setImportantForAccessibility(2); // NO
  attachTouch();
  frameLoop();
});
toast("主播采集 v" + SCRIPT_VERSION); // 版本号不常驻，只在启动时提示一次（荣耀会拦截这个提示，所以在日志里也写一行，见上面的“启动 v…”）

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
  setState("recover", "连续不是直播间画面");
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

// ---------------- 验证窗口识别（2.18，v4.8 补充） ----------------
// 客户遇到的情况：滑块验证盖在直播间上，脚本以为自己还在直播间里，一直停着。
// 识别（以 2.16 抓到的真实样本为准）：验证窗口是 WebView 里套 android.app.Dialog，里面的控件 id 是 captcha_container / verify-bar-close /
// secsdk-captcha-drag-wrapper。所以：①有 id 含 captcha / verify-bar / secsdk 的节点，或者 ②同时有大的 WebView 和 Dialog，就算验证窗口。
// 单独一个 WebView（直播间里的活动页也是 WebView）不算。检查放在每一轮的最前面，不等“卡片没弹出”之后才查。
// 处理：先自动按返回关掉它（保持绿色，悬浮窗上提示“已关闭验证窗口”）→ 还在就重启 TikTok → 还在就变红。
//       5 分钟内出现 3 次及以上 → 直接变红“验证太频繁”（暂停、振动，保护账号）。不做任何自动拉滑块的操作。
let verifyTimes = [], cardMiss = 0, stuck = 0, lastWatch = 0, overlayDumps = 0, bigLogged = 0;
function dumpTree(path, reason) {
  let out = ["时间=" + new Date().toTimeString().slice(0, 8) + " 原因=" + reason + " 前台=" + curPkg()], k = 0;
  let walk = (n, d) => {
    if (!n || k > 700) return;
    k++;
    try { out.push(new Array(d + 1).join(" ") + n.className() + " | id=" + n.id() + " | text=" + n.text() + " | desc=" + n.desc() + " | " + n.bounds() + " | vis=" + n.visibleToUser()); } catch (e) {}
    let c = 0; try { c = n.childCount(); } catch (e) {}
    for (let i = 0; i < c; i++) { let ch = null; try { ch = n.child(i); } catch (e) {} walk(ch, d + 1); }
  };
  try { walk(auto.root, 0); files.write(path, out.join("\n")); } catch (e) { log("保存界面样本失败: " + e); }
}
// 返回命中的描述；没有则返回 null
function overlaySuspect() {
  let r = null; try { r = auto.root; } catch (e) {}
  if (!r) return null;
  let total = W * H, k = 0, capId = null, web = null, dlg = null, big = null;
  let walk = (n) => {
    if (!n || capId || k > 800) return;
    k++;
    let cn = "", b = null, vis = false, nid = "";
    try { cn = String(n.className()); b = n.bounds(); vis = n.visibleToUser(); nid = String(n.id() || ""); } catch (e) {}
    if (b && vis && b.width() > 0 && b.height() > 0) {
      let area = b.width() * b.height() / total;
      if (/captcha|verify-bar|secsdk/i.test(nid)) capId = nid + " " + b;
      else if (/WebView/.test(cn) && area >= 0.08) web = web || ("WebView " + b);
      else if (/Dialog|Popup|BottomSheet|Modal/i.test(cn) && area >= 0.15) dlg = dlg || (cn + " " + b);
      else if (!big && area >= 0.3 && area < 0.85 && b.centerY() > H * 0.25 && b.centerY() < H * 0.75) big = cn + " " + b;
    }
    let c = 0; try { c = n.childCount(); } catch (e) {}
    for (let i = 0; i < c && !capId; i++) { let ch = null; try { ch = n.child(i); } catch (e) {} walk(ch); }
  };
  try { walk(r); } catch (e) { if (isInterrupt(e)) throw e; }
  let hit = capId ? "验证窗口 id=" + capId : (web && dlg ? web + " + " + dlg : null);
  if (hit && overlayDumps < 3) { overlayDumps++; dumpTree("/sdcard/Download/overlay_sample_" + overlayDumps + ".txt", "命中 " + hit); }
  else if (!hit && (web || big) && bigLogged < 5) { bigLogged++; log("2.18 候选（只记录，不触发）: " + (web || big)); }
  return hit;
}
// countIt = 这是不是一次确认的验证窗口（算进“5 分钟内 3 次”）；行为触发（卡片连续没弹出、翻页没反应）不算
function handleVerify(why, countIt) {
  let now = Date.now();
  if (countIt) { verifyTimes.push(now); verifyTimes = verifyTimes.filter((t) => now - t <= 5 * 60 * 1000); }
  log("验证窗口处理（" + why + "）" + (countIt ? "，5 分钟内第 " + verifyTimes.length + " 次" : ""));
  cardMiss = 0; stuck = 0;
  if (countIt && verifyTimes.length >= 3) {
    let n = verifyTimes.length; verifyTimes = [];
    haltWith("vfreq", "5 分钟内出现 " + n + " 次验证窗口");
    return;
  }
  setState("recover", "验证窗口，按返回"); // 先自动处理，保持绿色
  back(); sleep(random(1500, 2500));
  if (!overlaySuspect()) { showTip("已关闭验证窗口"); setState("run"); log("按返回关掉了验证窗口"); return; }
  log("按返回没关掉，重启 TikTok");
  stopTikTok(); app.launch(targetPkg); sleep(7000);
  enterLiveCounted("重启后");
  if (!overlaySuspect()) { showTip("已关闭验证窗口"); setState("run"); log("重启 TikTok 后验证窗口消失"); return; }
  haltWith("halt", "按返回和重启 TikTok 都没能关掉验证窗口");
}
// 需验证状态下，用户处理完不点 ▶，检测到弹窗消失也自动继续（“验证太频繁”不自动继续，要让账号休息）
function watchResume() {
  try {
    if (curPkg() !== targetPkg || overlaySuspect() || !anyHeader(800)) return;
    log("验证窗口已消失，自动继续");
    verifyTimes = []; backoffFailTimes = []; nonLive = 0; cardMiss = 0; stuck = 0;
    running = true; setState("run");
  } catch (e) { if (isInterrupt(e)) throw e; }
}

// 休息：每秒检查一次，用户点暂停或退出能立刻响应
function nap(ms, logLabel) {
  log(logLabel + " " + Math.round(ms / 1000) + "s");
  setRest(ms);
  for (let w = 0; w < ms && !stopped && running; w += 1000) sleep(1000);
  if (uiState === "rest") setState("run");
}

let lastNetCheck = 0, netSuspect = 0;
// 任何失败（不在直播间 / 没读到用户名 / 进不了 LIVE / 退避）发生时先做一次网络检测（3 秒超时）。网络不通就直接变红“无网络 / VPN 断开”，
// 停住进度环、等恢复，不进入退避。返回 true = 刚才是网络问题（已处理完，调用方应当 continue）
function netGate(why) {
  if (!running) return false;
  let ns = netState(CFG.netFailTimeoutMs);
  if (ns === "ok") { lastNetCheck = Date.now(); return false; }
  ring.mode = "idle"; // 进度环停住
  ensureNet(why, ns);
  return true;
}
// 退避没能回到直播间的计数（含“不在直播间”）：10 分钟内 3 次 → 红色“进不了直播”
function noteBackoffFail(why) {
  let now = Date.now();
  backoffFailTimes.push(now);
  backoffFailTimes = backoffFailTimes.filter((t) => now - t <= CFG.backoffWindowMs);
  log("没能回到直播间（" + backoffFailTimes.length + "/" + CFG.backoffFails + "）：" + why);
  if (backoffFailTimes.length >= CFG.backoffFails) {
    backoffFailTimes = [];
    haltWith("nolive", CFG.backoffWindowMs / 60000 + " 分钟内 " + CFG.backoffFails + " 次都没能回到直播间");
    return true;
  }
  return false;
}
// 检测网络；断开时自动暂停，悬浮窗显示 VPN 断开 / 无网络，每 15 秒重试，恢复后自动继续，不需要客户操作。
// ns = 已经测好的网络状态（可省略）。返回 false 表示等待期间被用户暂停或退出
function ensureNet(reason, ns) {
  ns = ns || netState();
  if (ns === "ok") { lastNetCheck = Date.now(); return true; }
  log("网络检测失败（" + reason + "），暂停，每 " + CFG.netRetryMs / 1000 + " 秒重试");
  while (!stopped && isCurrent() && running) {
    setState(ns, reason); // 每次重试都按最新结果更新（例如 Wi-Fi 回来了但 VPN 还没连上）
    for (let w = 0; w < CFG.netRetryMs && !stopped && running; w += 1000) { if (retryNow) { retryNow = false; break; } sleep(1000); }
    if (stopped || !running) return false;
    ns = netState();
    if (ns === "ok") {
      log("网络恢复，自动继续");
      setState("run");
      lastNetCheck = Date.now(); netSuspect = 0; missStreak = 0;
      return true;
    }
  }
  return false;
}

// 无障碍服务被关掉：显示“无障碍关闭”，每 2 秒查一次，权限恢复后自动继续
function waitAcc() {
  setState("noacc", "无障碍服务不可用");
  while (!stopped && isCurrent() && running && !accOk()) { retryNow = false; sleep(2000); }
  if (running && accOk()) { log("无障碍已恢复，自动继续"); setState("run"); }
}

threads.start(function () {
  while (!stopped) {
    if (!isCurrent()) { log("发现新启动的实例，本实例退出"); break; }
    if (!running) {
      if (uiState === "halt" && Date.now() - lastWatch > 3000) { lastWatch = Date.now(); watchResume(); }
      sleep(500); continue;
    }
    if (ring.mode === "idle") startCycle(5500);
    if (!accOk()) { waitAcc(); continue; }
    if (haltedByBackoff) { haltedByBackoff = false; backoffFailTimes = []; nonLive = 0; log("人工恢复，重新开始计数"); }
    if (Date.now() - lastNetCheck >= CFG.netCheckMs && !ensureNet(lastNetCheck ? "定时" : "启动")) continue;
    if (!ensureInApp()) {
      if (relaunchFails >= CFG.maxRelaunch) haltWith("notk", "连续 " + relaunchFails + " 次重新打开 TikTok 都失败");
      continue;
    }
    // 连续进不了直播间：网络有问题走断网流程；网络正常就暂停，请人手动打开 LIVE
    if (liveFails >= CFG.liveFailLimit) {
      liveFails = 0;
      let ns = netState();
      if (ns !== "ok") ensureNet("连续进不了直播间", ns);
      else haltWith("nolive", "网络正常，但连续 " + CFG.liveFailLimit + " 次进不了直播间");
      continue;
    }
    try {
      // 2.18：每一轮判断“是不是直播间”之前，先看有没有验证窗口盖在上面；网络有问题就先走断网流程
      let ov = overlaySuspect();
      if (ov) {
        let ns0 = netState();
        if (ns0 !== "ok") ensureNet("检测验证窗口时网络异常", ns0); else handleVerify("结构：" + ov, true);
        continue;
      }
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
        ringDone(added); // 读到并保存：环补满、闪一下、数字跳一下；重复的当作没读到，环退回 0
      } else {
        ringDone(false); // 没读到用户名：环平滑退回 0，不加数
        log(tag + "跳过：" + r.skip);
        showTip(r.skip.indexOf("非直播页") === 0 ? "不在直播间，跳过" : "没读到用户名，跳过");
        if (netGate("跳过：" + r.skip)) continue; // 先查网：断网 / 断 VPN 时直接变红，不走退避
        if (r.skip.indexOf("非直播页") === 0) {
          if (onHomeFeed()) { // 被带回了首页：直接重新进入 LIVE，不算退避
            log("在首页，重新进入 LIVE");
            setState("recover", "被带回了首页");
            if (enterLiveCounted("首页")) { setState("run"); backoffFailTimes = []; }
            else if (running && uiState !== "vpn" && uiState !== "nonet") noteBackoffFail("被带回首页后进不了 LIVE");
            nonLive = 0;
            continue;
          }
          if (++nonLive >= CFG.nonLiveStreak) {
            nonLive = 0;
            let ns = netState();
            if (ns !== "ok") { ensureNet("连续不是直播间画面", ns); continue; } // 网络问题走断网流程，不退避
            let now = Date.now();
            if (backoff()) { backoffFailTimes = []; log("退避成功，继续抓取"); setState("run"); }
            else {
              noteBackoffFail("退避后仍不是直播间");
            }
            continue;
          }
        } else { nonLive = 0; }
      }
      if (r.id) {
        netSuspect = 0; nonLive = 0; liveFails = 0; cardMiss = 0; stuck = 0;
        if (uiState === "recover") setState("run"); // 退避后第一次抓到，回到运行中
      }
      else if (/^(非直播页|卡片没弹出)/.test(r.skip)) {
        // 连续进不了 LIVE，或者卡片上出现 “Network error / Retry”，都检测一次网络
        netSuspect++;
        if (netSuspect >= CFG.netSuspectStreak || findVisible(textMatches(CFG.errorRe), 300)) {
          netSuspect = 0;
          if (!ensureNet("连续失败/网络错误")) continue;
        }
      }
      // 行为触发：连续 3 次卡片没弹出（可能被什么盖住了）。网络有问题先走断网流程
      if (!r.id && r.skip === "卡片没弹出") {
        cardMiss++;
        if (cardMiss >= 3) {
          let ns = netState();
          if (ns !== "ok") ensureNet("卡片没弹出", ns); else handleVerify("连续 " + cardMiss + " 次卡片没弹出", false);
          continue;
        }
      }

      if (count >= CFG.maxCount) { running = false; setState("pause"); toast("已达上限 " + count); log("已达上限"); continue; }
      if (added && count % CFG.restEvery === 0) nap(rnd(CFG.restMs), "休息");
      // 这一轮的各步骤时长现在就定下来，进度环按总时长匀速走：随机等待 + 滑动 + 等直播间加载 + 点头像 + 读用户名的最长等待
      let dly = rnd(CFG.delay), sw = rnd(CFG.swipeMs), pg = random(2000, 3000);
      startCycle(dly + sw + pg + 1200 + 2500);
      if (nextLive(sw, pg)) stuck = 0;
      else if (++stuck >= 2) {
        stuck = 0;
        let ns = netState();
        if (ns !== "ok") ensureNet("翻页没反应", ns); else handleVerify("两种翻页办法都没换房间", false);
        continue;
      }
      sleep(dly);
    } catch (e) {
      if (stopped || isInterrupt(e)) break; // 被停止，不能吞掉这个异常
      log("出错: " + e);
      sleep(2000);
    }
  }
});

if (files.exists(CFG.autostartFlag)) {
  running = true;
  setState("run");
  log("AUTOSTART 已开启");
}

setInterval(() => {}, 1000);
