/**
 * lib/diag-trace.js —— 诊断日志与请求追踪（P0.2-C 纯搬移）
 *
 * 从 `lib/index.js` 整段搬出：`appendDiagLine`（按大小 rotation 的 JSONL 诊断日志）、
 * `traceRequests` / `traceMediaRequests`（请求日志采样去重 + 媒体请求追踪）。
 * **逐字保真**：只做 +2 缩进与工厂包裹。
 *
 * `configPath()` 由内核从 `lib/kernel/data-dir.js` 注入；`diagBytes` / `reqLogSeen` 收在本工厂闭包里。
 */

import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function createDiagTraceKit(deps) {
  const { configPath } = deps;

  /**
   * 诊断落盘：把「非 200 的 HTTP 响应 / 路径围栏」按行追加到
   * `~/.dsh-wallpaper-engine/diag/http.jsonl`。
   *
   * 为什么用文件而不是 console.log：DSH Desktop 的运行日志只收录各插件 logger 的
   * 输出，host 的 stdout 拿不到 —— 排查「桌面端黑屏但浏览器正常」这类只在某个宿主
   * 环境出现的问题时，需要一个与宿主无关、事后可读的通道。
   *
   * 大小轮转：这条通道是**常开的**（渲染页上报 + 心跳 + 请求记录），没有上限时它会一路长到
   * 几十 MB（实测一段时间的会话即到 69.8 MB），而后人排查只需要最近的那一段。上限取
   * `DIAG_MAX_BYTES`，到顶就把当前文件改名为 `http.jsonl.1`（**只留一代**，更旧的被覆盖），
   * 于是目录占用有硬上界 2×上限。字节数在内存里累加，不做逐次 `statSync`。
   *
   * 不变量：无论轮转与否，`/diag-log`（内存环形缓冲的最近一段 —— **环形上限与返回窗口
   * 都由 `lib/routes/diag.js` 的 `diagLog` / `/diag-log` 处理器现算**）与每行的 JSON 形状都不变；
   * 轮转只发生在**写入之前**，绝不丢当次这一行。
   */
  const DIAG_MAX_BYTES = 8 * 1024 * 1024;
  let diagBytes = -1;   // -1 = 尚未探测盘上现有大小
  // 诊断目录只建一次（外部删目录时在 append 的 catch 里复位，下一行自愈）。
  let diagDirReady = false;
  /**
   * **常驻写句柄**（dynapaper 的 `LogSink` 同构）：每行一次 `write`，不再
   * `open + write + close` 三个 syscall。这条通道是常开的，写入频率从"每 5 秒一条"
   * 到"开了诊断详读后每帧一条"不等，同步 open/close 会把这些都摊到宿主主线程上。
   *
   * 句柄失效的三种现实形态都要自愈（不然诊断通道会静默死亡）：
   *   ① 文件被外部删除/清理工具清掉 ⇒ 下一次 `writeSync` 抛 ENOENT ⇒ 关句柄重开；
   *   ② 被并行实例抢先轮转（多实例共用同一个 diag 目录）⇒ 我们的 fd 指向已改名的旧
   *      inode，**写入成功但写进没人看的那份** ⇒ 每 `DIAG_FD_RECHECK_EVERY` 行对一次盘上
   *      size（不做逐行 stat），与内存计数不符就重开并从盘上重建计数；
   *   ③ 数据目录被改（`DSH_WE_DATA_DIR` / 迁移）⇒ 路径变了直接重开。
   */
  const DIAG_FD_RECHECK_EVERY = 256;
  let diagFd = -1;
  let diagFdFile = '';
  let diagSinceCheck = 0;
  function diagCloseFd() {
    if (diagFd >= 0) { try { closeSync(diagFd); } catch { /* ignore */ } }
    diagFd = -1;
    diagFdFile = '';
  }
  function diagEnsureFd(file) {
    if (diagFd >= 0 && diagFdFile === file) return diagFd;
    diagCloseFd();
    diagFd = openSync(file, 'a');
    diagFdFile = file;
    return diagFd;
  }
  function appendDiagLine(kind, obj) {
    try {
      const dir = join(dirname(configPath()), 'diag');
      // 目录只可能被**外部**删掉（清理工具 / 用户手删）⇒ 失败时把记忆化标记复位，
      // 下一行再试一次，不把诊断通道永久弄死。mkdir 成功一次之后不再付这个 syscall：
      // 上一版每行都 mkdir（递归）一次，是诊断写路径上唯一的固定开销。
      if (!diagDirReady) {
        try {
          mkdirSync(dir, { recursive: true });
          diagDirReady = true;
        } catch (err) {
          diagDirReady = false;
          throw err;
        }
      }
      const file = join(dir, 'http.jsonl');
      if (diagBytes < 0) diagBytes = existsSync(file) ? statSync(file).size : 0;
      if (diagFd >= 0 && diagFdFile !== file) diagCloseFd();
      // 周期性对账（③ 与 ② 的共同出口）：盘上大小与内存计数不符 ⇒ 有人在别处动过它。
      if (diagFd >= 0 && ++diagSinceCheck >= DIAG_FD_RECHECK_EVERY) {
        diagSinceCheck = 0;
        let onDisk = -1;
        try { onDisk = statSync(file).size; } catch { /* 不存在 ⇒ 下面按 0 处理 */ }
        if (onDisk !== diagBytes) {
          diagCloseFd();
          diagBytes = onDisk > 0 ? onDisk : 0;
        }
      }
      if (diagBytes >= DIAG_MAX_BYTES) {
        // 文件可能已被清理工具删除、或被并行实例抢先轮转（诊断文件多实例共用）——
        // rename ENOENT 若不加防，此后每次 append 都在 rename 处抛、被外层 catch 吞，
        // 诊断通道对本次进程**静默死亡**。缺失/竞态一律按新文件从零计。
        //
        // ⚠️ 句柄**无条件**关掉：即便本轮不轮转（文件已被别处搬走），旧 fd 也指着那个
        // 被搬走的 inode —— 拿着它写会"成功"但写进没人看的那份（实测：读新文件行数=0）。
        diagCloseFd();
        if (existsSync(file)) {
          try {
            renameSync(file, file + '.1');
          } catch {
            /* 被并行实例抢先 ⇒ 本次不轮转，现有文件继续追加 */
          }
        }
        diagBytes = 0;
      }
      const line = JSON.stringify({ t: Date.now(), kind, ...obj }) + '\n';
      const buf = Buffer.from(line, 'utf8');
      let fd = diagEnsureFd(file);
      try {
        writeSync(fd, buf);
      } catch {
        // ENOENT / EACCES（文件被删、目录被清）：关句柄重开一次，仍失败就走外层 catch。
        diagCloseFd();
        fd = diagEnsureFd(file);
        writeSync(fd, buf);
      }
      diagBytes += buf.length;
    } catch { /* 诊断失败不影响服务 */ }
  }

  /**
   * 请求记录（含成功的 200）：同 route+path 十秒内只记一条，避免刷屏。
   *
   * 为什么连 200 也要记：排查「画面黑但服务端无任何 4xx」时，唯一的判据是
   * **某个请求到底有没有发生**（例如壁纸入口是否真被 iframe 请求过）——
   * 只看错误码会把「没请求」与「请求成功」混为一谈。
   *
   * ⚠️ 这张表**必须有上界**：键里带**请求可控**的路径段（`/scene-files` 子路径、
   * `/live-frame` 的 token、`/scene-live` 的 pathname …），而请求方是任意页面。
   * 只 get/set 而不回收时，会话期内互不相同的请求会让堆**单向增长**（实测 20 万个不同的
   * `/live-frame/<随机>` 把 heapUsed 从 32.2MB 抬到 72.4MB 且不释放）。
   * 下面的 TTL 只抑制**写入**，不清理条目 ⇒ 上界由 `REQ_LOG_SEEN_MAX` 单独保证。
   */
  const REQ_LOG_DEDUP_MS = 10000;
  /** 去重表的硬上界（条）。超界按插入序淘汰最旧的 ⇒ 内存有界。 */
  const REQ_LOG_SEEN_MAX = 2000;
  const reqLogSeen = new Map();
  /**
   * 去重判定 + 记账。返回 true 表示"这一条该落盘"。
   *
   * 上界与去重是**两个**要求，冲突时上界优先：条目被淘汰后同一键可能再落一条重复行 ——
   * 这是可接受的（诊断去重本就是尽力而为），而内存有界是硬要求。
   */
  function reqLogSeenTouch(key, now, ttlMs) {
    const last = reqLogSeen.get(key);
    if (last !== undefined && now - last < ttlMs) return false;
    reqLogSeen.set(key, now);
    // Map 保持插入序 ⇒ 队首就是最旧的键。
    while (reqLogSeen.size > REQ_LOG_SEEN_MAX) {
      const oldest = reqLogSeen.keys().next();
      if (oldest.done) break;
      reqLogSeen.delete(oldest.value);
    }
    return true;
  }
  /**
   * 诊断里的路径折叠：场景/网页壁纸的路径首段是 base64 的绝对路径（很长），
   * 原样落盘等于什么都没记（只剩一串 base64）。折叠成 `<token>/…`，留下真正
   * 有信息量的文件名 / 子路径。
   */
  function foldTokenPath(p) {
    const raw = String(p || '');
    const slash = raw.indexOf('/');
    return (slash > 40 ? '<token>/' + raw.slice(slash + 1) : raw).slice(0, 150);
  }
  function traceRequests(res, route, pathKey) {
    try {
      const key = route + '\u0000' + String(pathKey);
      const now = Date.now();
      if (!reqLogSeenTouch(key, now, REQ_LOG_DEDUP_MS)) return;
      res.on('finish', () => {
        appendDiagLine('req', {
          route,
          path: foldTokenPath(pathKey),
          status: res.statusCode || 0,
          dest: String(res.req && res.req.headers ? res.req.headers['sec-fetch-dest'] || '' : ''),
        });
      });
    } catch { /* ignore */ }
  }
  /**
   * 媒体源（独立 loopback 源）的请求记录：只记**文档型请求**与**错误响应**。
   * 网页壁纸的子资源动辄上百个，全量落盘会把诊断环冲掉；而排查黑屏真正需要的判据
   * 只有两条：壁纸入口到底有没有被请求到、有没有被拒绝。
   */
  function traceMediaRequests(req, res, pathKey) {
    try {
      const key = foldTokenPath(pathKey);
      const tail = key.split('/').pop() || '';
      const isDoc = tail === '' || /\.html?$/i.test(tail) || !/\.[a-z0-9]{1,8}$/i.test(tail);
      res.on('finish', () => {
        const status = res.statusCode || 0;
        if (!isDoc && status < 400) return;
        appendDiagLine('req', {
          route: 'scene-files@media',
          path: key,
          status,
          dest: String(req.headers['sec-fetch-dest'] || ''),
        });
      });
    } catch { /* 诊断失败不影响服务 */ }
  }

  // ── 对外面：只有**被消费的**那几个 ───────────────────────────────────────────
  // `appendDiagLine` / `traceRequests` / `traceMediaRequests` 由内核解构后注入各族
  // （`lib/kernel/host-kernel.js` 的解构处）；`foldTokenPath` 是上游门面的同名导出（token 折叠的唯一实现，
  // 判据 D 段直接对它下断言）。其余内部常量与状态（`DIAG_MAX_BYTES` / `diagBytes` /
  // `REQ_LOG_*` / `reqLogSeen` / `reqLogSeenTouch`）**不外泄** —— 判据 H1 用"键集逐字相等"
  // 钉住这条面，外泄一个名字就判红。
  return {
    appendDiagLine,
    foldTokenPath,
    traceRequests,
    traceMediaRequests,
  };
}

