/**
 * dsh-startup-animation —— DSH 启动动画 + 主界面壁纸（宿主侧）。
 *
 * 做五件事：
 *   1. 图片槽位：`avatar` / `bg` / `bgDark` 各一个，用户上传的图放 `$DSH_HOME/dsh-startup-animation/`
 *      （文件名前缀分别是 `avatar.` / `bg.` / `bg-dark.`），没有就用包里自带的
 *      `assets/toxiang.jpg`、`assets/bizhi.jpg`；`bgDark` 没传过图时直接继承 `bg` 那张；
 *   2. 主界面 hero 的配置（问候语、打字机、光标、是否隐藏 logo/徽章）存成
 *      `$DSH_HOME/dsh-startup-animation/config.json`，读和写都过一遍校验；
 *      主界面壁纸的四个透明度（`sidebarOpacity` / `sidebarOpacityDark` 侧栏底色不透明度、
 *      `veilOpacity` / `veilOpacityDark` 白纱浓度，浅色与暗色各一组）也在同一份配置里，
 *      由 `configScript` 在首帧前写成 `<html>` 上的 CSS 变量；
 *   3. 具名路由：`/dsh-startup/{boot.js,avatar,bg}` 供页面取用，
 *      `/dsh-startup/images[...]` 供设置页读状态、传图、恢复默认，
 *      `/dsh-startup/config` 供设置页读/存 hero 配置，
 *      `/dsh-startup/preview` 是给设置页内嵌的自包含预览页（换图后立刻能看效果）；
 *   4. 用 `webServer.tapIndex` 往 index.html 里塞三段样式与一段脚本：`<head>` 里是启动页关键 CSS
 *      （收尾时由 boot.js 移除）、常驻的主界面壁纸 CSS 与 hero 改造 CSS，
 *      `</body>` 前是 boot.js（启动页 DOM 都在这）；
 *   5. 插件卸载时收回全部注册。
 *
 * 页面侧：`assets/boot.js`（动画）、`assets/boot.css`（启动页样式）、`assets/wallpaper.css`（主界面样式）、
 * `assets/hero.css`（主界面 hero 改造样式）、`client/client.js`（设置页签）。
 * 都可以直接改；改 client.js 由客户端 HMR 热更，改其余要重启宿主。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'dsh-startup-animation'
const BASE = '/dsh-startup'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, NAME)
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }

/** 三个图片槽位：槽位名 → 用户文件名前缀 + 包内默认图 +（可选）没传图时继承哪个槽位。 */
const SLOTS = {
  avatar: { file: 'avatar', fallback: 'toxiang.jpg' },
  bg: { file: 'bg', fallback: 'bizhi.jpg' },
  // 暗色壁纸：没单独传过图就一直跟着浅色那张走 —— 连用户换过的浅色图也算，
  // 所以它自己不设内置图，`inherit` 指到 bg（见 imageOf / imageState）。
  bgDark: { file: 'bg-dark', fallback: 'bizhi.jpg', inherit: 'bg' },
}

const CONFIG_FILE = join(DATA_DIR, 'config.json')
const MAX_CONFIG_BYTES = 64 * 1024

/**
 * 默认配置。分三块：
 *   · 主界面 hero（`headline` 逐字打出来的问候语、打字机、光标、摘 logo/徽章）
 *   · 启动动画画质档位（`fx`：eco 省电 / standard 标准 / fancy 华丽；`forceMotion` 覆盖系统的"减少动态效果"）
 *   · 节日彩蛋（`festival`：auto 跟随日期 / off 关闭 / 手动指定一个；`birthday` 是 MM-DD）
 */
const DEFAULT_CONFIG = {
  headline: '你好，我是和栗薰子，欢迎使用Deepseek Harness',
  typewriter: true,
  speed: 70,
  cursor: true,
  cursorChar: '|',
  hideLogo: true,
  hideBadge: true,
  fx: 'standard',
  forceMotion: false,
  festival: 'auto',
  birthday: '',
  // 主界面壁纸的四个透明度旋钮（百分比，0~100；浅色 / 暗色各一组）：
  //   sidebarOpacity / sidebarOpacityDark —— 侧栏底色（--dsw-specific-sidebar-fill，
  //       由 dsh-client-ui-sidebar 消费）的不透明度：0 = 侧栏全透明、壁纸直接透出来；
  //       100 = 不透明；78 / 82 就是原来的观感（浅色 .78，暗色取同一个意图）
  //   veilOpacity / veilOpacityDark —— 压在壁纸上的白纱浓度，越大壁纸越淡
  //       （浅色 80 对应原来的 .8/.68；暗色 90，因为深色界面的文字是浅色的，得压得更暗）
  veilOpacity: 80,
  veilOpacityDark: 90,
  sidebarOpacity: 78,
  sidebarOpacityDark: 82,
}

const FX_TIERS = ['eco', 'standard', 'fancy']
const FESTIVALS = ['auto', 'off', 'sakura', 'snow', 'newyear', 'birthday']

/**
 * 校验并补齐一份配置：字段类型不对就用 `base` 里的值，字符串截断、速度夹到 10~1000ms、
 * 枚举值不在白名单里就退回原值。这样无论页面传来什么（空、缺字段、乱类型、超长文案），
 * 落盘的一定是完整可用的一份。
 * @param input - 页面传来的（可能是局部的）配置
 * @param base - 缺省值来源：读盘时传 DEFAULT_CONFIG，保存时传当前配置
 */
function sanitizeConfig(input, base) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const text = (value, fallback, max) => (typeof value === 'string' ? value.slice(0, max) : fallback)
  const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
  // 透明度是百分比整数：非数字退回原值，越界夹到 0~100（小数四舍五入），保证落盘的一直是可用值
  const percent = (value, fallback) => (Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : fallback)
  return {
    headline: text(source.headline, base.headline, 200),
    typewriter: flag(source.typewriter, base.typewriter),
    speed: Number.isFinite(source.speed) ? Math.min(1000, Math.max(10, Math.round(source.speed))) : base.speed,
    cursor: flag(source.cursor, base.cursor),
    cursorChar: text(source.cursorChar, base.cursorChar, 4),
    hideLogo: flag(source.hideLogo, base.hideLogo),
    hideBadge: flag(source.hideBadge, base.hideBadge),
    fx: pick(source.fx, FX_TIERS, base.fx),
    forceMotion: flag(source.forceMotion, base.forceMotion),
    festival: pick(source.festival, FESTIVALS, base.festival),
    birthday: birthdayValue(source.birthday, base.birthday),
    veilOpacity: percent(source.veilOpacity, base.veilOpacity),
    veilOpacityDark: percent(source.veilOpacityDark, base.veilOpacityDark),
    sidebarOpacity: percent(source.sidebarOpacity, base.sidebarOpacity),
    sidebarOpacityDark: percent(source.sidebarOpacityDark, base.sidebarOpacityDark),
  }
}

/**
 * 生日解析：**吃得宽一点**，因为"格式挑食 + 静默退回"会让用户以为什么都没保存
 * （真实反馈：输入 2-14 之后保存，输入框自己变回空）。
 *   `2-14` / `02/14` / `2.14` / `2月14日` / `12-24` / `2026-12-24` / `0214` 都认，统一成 `MM-DD`。
 * @returns 空串＝没填；`MM-DD`＝解析成功；`null`＝看不懂（调用方据此提示，而不是默默丢掉）
 */
function normalizeBirthday(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '') return ''
  const patterns = [
    /^(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/,              // 2-14 / 02/14 / 2.14 / 2月14日
    /^\d{4}\s*[-/.]?\s*(\d{1,2})\s*[-/.]?\s*(\d{1,2})$/,   // 2026-12-24 / 20261224
    /^(\d{2})(\d{2})$/,                                      // 0214 / 1224（连写四位）
  ]
  for (const pattern of patterns) {
    const matched = pattern.exec(raw)
    if (matched === null) continue
    const month = Number(matched[1])
    const day = Number(matched[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  return null
}

/** 配置里的生日：解析成功就用规范值，看不懂就退回原值（配置本身永远保持可用）。 */
function birthdayValue(value, fallback) {
  const normalized = normalizeBirthday(value)
  return normalized === null ? fallback : normalized
}

/** 今天几月几日，压成 MMDD 整数，方便直接比大小（跨年的窗口靠 or 处理）。 */
function dayIndex(date) {
  return (date.getMonth() + 1) * 100 + date.getDate()
}

/** 今天几月几日，补零成 MM-DD，用来和配置里的生日比。 */
function monthDay(date) {
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 跟着日期走的节日窗口。新年那几天优先于飘雪（1 月 1~3 日两个窗口重叠）。 */
function autoFestival(date) {
  const day = dayIndex(date)
  if (day >= 101 && day <= 103) return 'newyear'
  if (day >= 320 && day <= 420) return 'sakura'
  if (day >= 1201 || day <= 215) return 'snow'
  return ''
}

/**
 * 今天到底演哪一出：
 *   · `off`：什么都不演；
 *   · 手动选了一个：**就演那一个**（"我现在就想看看"的语义）。生日日期只服务自动模式，
 *     所以手选「生日」不用先填日期 —— 之前要求填日期才生效，结果选完什么都不演，很坑；
 *   · `auto`：生日（填了且就是今天）优先，然后按日期窗口。
 * @param config - 已校验的配置
 * @param date - 基准时间（自检里会传固定日期进来）
 * @returns 节日 id，没有就是空串
 */
function activeFestival(config, date) {
  if (config.festival === 'off') return ''
  if (config.festival !== 'auto') return config.festival
  if (config.birthday !== '' && config.birthday === monthDay(date)) return 'birthday'
  return autoFestival(date)
}

/**
 * 首帧前就跑的小脚本：把配置交给页面侧（boot.js / client.js 都读它），
 * 同时把画质档位、强制动效、节日这几个类挂到 `<html>` 上 —— 必须早于首帧，
 * 否则 CSS 里的档位/配色会在第一帧之后才生效，看起来就是"闪一下"。
 * 主界面壁纸的两个透明度同样在这一步写进 `<html>` 的行内样式（wallpaper.css 用带 fallback 的
 * `var()` 读），晚一步就会"先按默认浓度画一帧、再跳到配置值"。
 */
function configScript(config, festival) {
  // `<` 转义，免得配置里的文案把 script 标签提前闭合
  const payload = JSON.stringify({ ...config, festivalActive: festival }).replace(/</g, '\\u003c')
  const classes = [`dshs-fx-${config.fx}`]
  if (config.forceMotion === true) classes.push('dshs-force-motion')
  if (festival !== '') classes.push(`dshs-fest-${festival}`)
  const add = classes.map((name) => `document.documentElement.classList.add(${JSON.stringify(name)});`).join('')
  const alpha = (value, fallback) => String((Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback) / 100)
  // 四个变量一次写全：浅色一套、暗色一套。主题把 data-ds-dark-theme 挂在 body 上，
  // 两套值都留在 `<html>` 上由 CSS 各取所需 —— 于是切换主题不需要任何 JS 参与。
  const vars = 'document.documentElement.style.setProperty("--dshs-veil",' + JSON.stringify(alpha(config.veilOpacity, DEFAULT_CONFIG.veilOpacity)) + ');'
    + 'document.documentElement.style.setProperty("--dshs-veil-dark",' + JSON.stringify(alpha(config.veilOpacityDark, DEFAULT_CONFIG.veilOpacityDark)) + ');'
    + 'document.documentElement.style.setProperty("--dshs-sidebar",' + JSON.stringify(alpha(config.sidebarOpacity, DEFAULT_CONFIG.sidebarOpacity)) + ');'
    + 'document.documentElement.style.setProperty("--dshs-sidebar-dark",' + JSON.stringify(alpha(config.sidebarOpacityDark, DEFAULT_CONFIG.sidebarOpacityDark)) + ');'
  return `<script>window.__dshsConfig=${payload};${add}${vars}</script>`
}


/** 读配置：文件不在、读不动或者内容坏了，都当"默认配置"，绝不让页面拿到半份东西。 */
function readConfig() {
  try {
    return sanitizeConfig(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')), DEFAULT_CONFIG)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** 原子落盘：先写 .tmp 再改名，避免读取方撞上写了一半的文件。 */
function writeConfig(config) {
  mkdirSync(DATA_DIR, { recursive: true })
  const temp = CONFIG_FILE + '.tmp'
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n')
  renameSync(temp, CONFIG_FILE)
}

/**
 * 紧跟 `<head>` 同步执行的早脚本：趁首帧之前把主界面藏起来，避免"先闪一下主界面再盖上"。
 * 60 秒内的重复刷新直接跳过（自动重载循环不该每次放动画）；8 秒还没收尾就自行放行，
 * 保证 boot.js 万一没加载也不会白屏。
 */
const EARLY = '<script>(function(){var h=document.documentElement,k="dshs-at";'
  + 'try{var t=sessionStorage.getItem(k);if(t&&Date.now()-+t<6e4)return}catch(e){}'
  + 'h.classList.add("dshs-boot");'
  + 'setTimeout(function(){h.classList.remove("dshs-boot")},8e3)})()</script>'

function asset(name) {
  return readFileSync(join(PACKAGE_ROOT, 'assets', name))
}

/** 只认这四种图片：按魔数判断，不信 Content-Type。 */
function sniffExt(body) {
  if (body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'jpg'
  if (body.length > 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return 'png'
  if (body.length > 3 && body.toString('latin1', 0, 3) === 'GIF') return 'gif'
  if (body.length > 12 && body.toString('latin1', 0, 4) === 'RIFF' && body.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

/** 用户给这个槽位传的图（没有就是 null）。 */
function userImage(slot) {
  const prefix = SLOTS[slot].file + '.'
  let names = []
  try {
    names = readdirSync(DATA_DIR)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const ext = name.slice(prefix.length)
    if (TYPES[ext] === undefined) continue
    const path = join(DATA_DIR, name)
    try {
      const stat = statSync(path)
      return { path, ext, bytes: stat.size, mtime: stat.mtimeMs }
    } catch {
      return null
    }
  }
  return null
}

/**
 * 页面拿到的这张图：用户图优先，其次继承别的槽位（暗色壁纸跟随浅色），最后才是包内默认图。
 * `depth` 只是护栏：万一以后有人把 inherit 写出环，也有个尽头，不会递归到栈溢出。
 */
function imageOf(slot, depth = 0) {
  const user = userImage(slot)
  if (user !== null) return { body: readFileSync(user.path), type: TYPES[user.ext], custom: true }
  const inherit = SLOTS[slot].inherit
  if (inherit !== undefined && depth < 4) return imageOf(inherit, depth + 1)
  const fallback = SLOTS[slot].fallback
  return { body: asset(fallback), type: TYPES[fallback.split('.').pop()], custom: false }
}

/**
 * 设置页读的状态。继承来的槽位（暗色壁纸没单独设过）会把被继承那张的 bytes/mtime 一起带上，
 * 并标 `inherited: true`：这样设置页能写"跟随浅色壁纸"，缩略图也会在浅色换图后跟着更新。
 * 依赖 Object.keys 的顺序 —— `inherit` 指向的槽位必须写在前面（bg 在 bgDark 之前）。
 */
function imageState() {
  const state = {}
  for (const slot of Object.keys(SLOTS)) {
    const user = userImage(slot)
    if (user !== null) {
      state[slot] = { custom: true, bytes: user.bytes, mtime: Math.round(user.mtime) }
      continue
    }
    const inherit = SLOTS[slot].inherit
    if (inherit !== undefined && state[inherit] !== undefined) {
      state[slot] = Object.assign({}, state[inherit], { custom: false, inherited: true })
      continue
    }
    state[slot] = { custom: false, bytes: asset(SLOTS[slot].fallback).length }
  }
  return state
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(value)))
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        const text = limit >= 1024 * 1024
          ? `${Math.round(limit / 1024 / 1024)}MB`
          : `${Math.round(limit / 1024)}KB`
        reject(new Error(`内容超过 ${text} 上限`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 收到一张图：验大小、验魔数、原子落盘，并清掉该槽位的旧文件。 */
async function upload(slot, req, res) {
  try {
    const body = await readBody(req, MAX_UPLOAD_BYTES)
    if (body.length === 0) throw new Error('收到空内容')
    const ext = sniffExt(body)
    if (ext === null) throw new Error('只认 JPEG / PNG / WebP / GIF')
    mkdirSync(DATA_DIR, { recursive: true })
    const keep = `${SLOTS[slot].file}.${ext}`
    const temp = join(DATA_DIR, keep + '.tmp')
    writeFileSync(temp, body)
    renameSync(temp, join(DATA_DIR, keep))
    const prefix = SLOTS[slot].file + '.'
    for (const name of readdirSync(DATA_DIR)) {
      if (name !== keep && name.startsWith(prefix) && TYPES[name.slice(prefix.length)] !== undefined) {
        rmSync(join(DATA_DIR, name), { force: true })
      }
    }
    sendJson(res, 200, { ok: true, slot, ext, bytes: body.length, state: imageState() })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/** 恢复默认：把这个槽位的用户图删掉，页面回落到包内自带图。 */
function reset(slot, res) {
  try {
    const user = userImage(slot)
    if (user !== null) rmSync(user.path, { force: true })
    sendJson(res, 200, { ok: true, slot, state: imageState() })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 配置：GET 读一份，POST 存一份（body 是 JSON，可以是局部字段；`{"reset": true}` 回默认）。
 * 保存是"当前配置 + 传来的字段"再校验，所以页面只发改过的字段也不会把别的项打回默认。
 * 两种请求都回报一次 `festival`（今天到底演哪一出），设置页据此显示"今天生效：…"。
 */
async function configRoute(req, res) {
  if (req.method !== 'POST') {
    const config = readConfig()
    sendJson(res, 200, { ok: true, config, festival: activeFestival(config, new Date()) })
    return
  }
  try {
    const body = await readBody(req, MAX_CONFIG_BYTES)
    const input = body.length === 0 ? {} : JSON.parse(body.toString('utf8'))
    if (input !== null && typeof input === 'object' && input.reset === true) {
      const fresh = { ...DEFAULT_CONFIG }
      writeConfig(fresh)
      sendJson(res, 200, { ok: true, config: fresh, festival: activeFestival(fresh, new Date()) })
      return
    }
    // 合并时以"当前配置"为底：输入里没提到的字段保持不动，提到了但值不合法也退回当前值
    // （而不是悄悄打回默认 —— 用户手滑发个乱值不该把他的档位重置掉）
    const current = readConfig()
    const next = sanitizeConfig({ ...current, ...input }, current)
    writeConfig(next)
    // 生日看不懂时要说出来：以前是静默退回原值，页面上输入框自己变回空，用户只会以为"存不上"
    const asked = input !== null && typeof input === 'object' ? input.birthday : undefined
    const warning = normalizeBirthday(asked) === null
      ? `生日「${String(asked).slice(0, 12)}」没看懂，请按 MM-DD 填（例如 02-14、2-14、0214 都行）；其它项已经保存`
      : null
    const answer = { ok: true, config: next, festival: activeFestival(next, new Date()) }
    if (warning !== null) answer.warning = warning
    sendJson(res, 200, answer)
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 预览页里那个假主界面的配色：浅色 / 暗色各一套。
 * 假界面不加载宿主的样式表（它是独立文档，没有那些 --dsw-* token），所以这里自带一份，
 * 取值与主题自己的 token 对齐：暗色底 #151517（bluish-950）、侧栏底 #1b1b1c（bluish-900）、
 * 正文色 #f9fafb、次要文字 #adb2b8。
 */
const PREVIEW_PALETTE = {
  light: {
    label: '#22303f', aside: '#55617a', hint: '#7a869c', bg: '#fff', base: '#fff',
    sidebar: '#eef0f7', border: '#dde1ec', shadow: 'rgba(34, 48, 63, .4)',
    replayBorder: '#d1d5db', replayBg: 'rgba(255, 255, 255, .92)',
  },
  dark: {
    label: '#f9fafb', aside: '#adb2b8', hint: '#8b93a1', bg: '#151517', base: '#151517',
    sidebar: '#1b1b1c', border: '#3a3b41', shadow: 'rgba(0, 0, 0, .6)',
    replayBorder: '#3a3b41', replayBg: 'rgba(35, 35, 36, .92)',
  },
}

/**
 * 预览页里那个假主界面的样式。只为看清过场，与真实 DSH 布局无关；
 * 底色挂在同名变量上，所以壁纸样式（含两套白纱/侧栏变量）能直接套进预览。
 * @param dark - 是否按暗色主题渲染（设置页按当前主题把 `?dark=1` 带进来）
 */
function previewCss(dark) {
  const color = dark ? PREVIEW_PALETTE.dark : PREVIEW_PALETTE.light
  return `
  html, body { margin: 0; height: 100%; }
  body {
    font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: ${color.label}; background: ${color.bg};
    --dsw-alias-bg-base: ${color.base}; --dsw-specific-sidebar-fill: ${color.sidebar};
  }
  .pv { display: flex; height: 100vh; background: var(--dsw-alias-bg-base); }
  .pv aside { width: 200px; box-sizing: border-box; padding: 16px; background: var(--dsw-specific-sidebar-fill); font-size: 12px; color: ${color.aside}; }
  .pv aside b { display: block; margin-bottom: 12px; color: ${color.label}; font-size: 13px; }
  .pv aside i { display: block; padding: 8px 10px; border-radius: 8px; font-style: normal; }
  .pv main { flex: 1; min-width: 0; display: flex; flex-direction: column; box-sizing: border-box; padding: 22px 26px; }
  .pv h1 { margin: 0 0 6px; font-size: 17px; }
  .pv p { margin: 0; color: ${color.hint}; font-size: 12px; }
  .pv .composer { margin-top: auto; padding: 10px 12px; border: 1px solid ${color.border}; border-radius: 14px; background: ${color.base}; box-shadow: 0 6px 20px -12px ${color.shadow}; }
  .pv textarea { width: 100%; height: 44px; border: 0; outline: 0; resize: none; font: inherit; font-size: 13px; background: transparent; color: inherit; }
  #dshs-replay { position: fixed; right: 14px; bottom: 14px; z-index: 1; height: 30px; padding: 0 14px; border: 1px solid ${color.replayBorder}; border-radius: 999px; background: ${color.replayBg}; color: ${color.label}; font: inherit; font-size: 12px; cursor: pointer; opacity: 0; pointer-events: none; transition: opacity .4s ease .6s; }
  #dshs-replay.is-ready { opacity: 1; pointer-events: auto; }
`
}

/**
 * 预览页里假主界面的挂载脚本：延迟 2.6s 才出现，模拟真实 app 建连 + 首屏耗时，
 * 这样过场才看得出是"启动页撤离、主界面接上"，而不是两边同时冒出来。
 */
const PREVIEW_JS = `
  // 启动页盖着的时候别把「重播」露出来（它是 fixed，会透在动画上）
  var replayTimer = setInterval(function () {
    if (document.getElementById('dshs')) return
    clearInterval(replayTimer)
    document.getElementById('dshs-replay').classList.add('is-ready')
  }, 200)
  setTimeout(function () {
    document.getElementById('root').innerHTML =
      '<div class="pv">' +
        '<aside><b>DeepSeek Harness</b><i>新会话</i><i>会话记录</i><i>插件</i><i>设置</i></aside>' +
        '<main><h1>主界面</h1>' +
        '<p>启动页撤离后由 #root 的淡入归位接上；背景图换掉，这里的壁纸也会跟着变。</p>' +
        '<div class="composer"><textarea placeholder="给 DeepSeek Harness 发消息…"></textarea></div>' +
        '</main>' +
      '</div>'
  }, 2600)
`

/**
 * 预览页：同一份启动页样式 + 壁纸样式 + boot.js，挂在一个假主界面上。
 * 设置页把它塞进 iframe（sandbox="allow-scripts"），换完图立刻能看到效果；也可以直接开新标签页。
 *
 * 壁纸样式要一并带上：主界面壁纸画在 body 上，而启动页收尾正是要和它对齐交接——
 * 少了这段，预览里就看不到"背景由虚转实"那一下。
 *
 * 与真实页面的两点差别：无条件加上 `.dshs-boot`（不参与早脚本的"60 秒内跳过"），
 * 以及置上 `__dshsNoRemember`，免得在预览里看一遍就把真实页面的动画也标记成"已经播过"。
 * 画质档位与节日也一并带进来：预览里看到的就是真实开机那一份。
 *
 * 暗色主题下设置页会带 `?dark=1` 进来：假界面换一套深色配色，body 上挂 `data-ds-dark-theme`，
 * 壁纸样式里那条暗色分支就会接手（白纱/侧栏用暗色那一组值）。
 * 启动动画本身仍是浅色的（这一版没有适配它），所以暗色预览看到的就是真实的过场：
 * 浅色动画 → 收尾白纱转深 → 落到深色主界面。
 * @param splashCss - 启动页关键样式，与注入 index.html 的那份完全相同
 * @param wallCss - 主界面壁纸样式，同样与真实页面一致
 * @param config - 当前配置（读盘结果）
 * @param festival - 今天生效的节日（空串＝没有）
 * @param dark - 是否按暗色主题渲染预览页
 */
function previewPage(splashCss, wallCss, config, festival, dark) {
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>DSH 启动动画 · 预览</title>\n'
    + '<style>' + previewCss(dark) + '</style>\n'
    + '<style id="dshs-css">' + splashCss + '</style>\n'
    + '<style id="dshs-wall-css">' + wallCss + '</style>\n'
    + configScript(config, festival) + '\n'
    + '<script>window.__dshsNoRemember = true;document.documentElement.classList.add("dshs-boot")</script>\n'
    + '</head>\n<body' + (dark ? ' data-ds-dark-theme' : '') + '>\n'
    + '<div id="root"></div>\n'
    + '<button id="dshs-replay" type="button" onclick="location.reload()">重播</button>\n'
    + '<script>' + PREVIEW_JS + '</script>\n'
    + '<script defer src="' + BASE + '/boot.js"></script>\n'
    + '</body>\n</html>\n'
}

/**
 * 把启动页、壁纸与 hero 改造标记注入 index.html。幂等：已经注入过的 HTML 原样返回。
 * @param html - 宿主渲染好的 index.html
 * @param splashCss - 启动页关键样式（`<head>`，启动页收尾时移除）
 * @param wallCss - 主界面壁纸样式（`<head>`，常驻）
 * @param heroCss - 主界面 hero 改造样式（`<head>`，常驻；hero 在启动页撤掉之后才渲染）
 * @param config - 当前配置（读盘结果）；档位/节日/强制动效这几个类由它带来的小脚本挂上 `<html>`
 * @param festival - 今天生效的节日（空串＝没有）
 */
function inject(html, splashCss, wallCss, heroCss, config, festival) {
  if (html.indexOf(BASE + '/boot.js') !== -1) return html
  const head = '<style id="dshs-css">' + splashCss + '</style>'
    + '<style id="dshs-wall-css">' + wallCss + '</style>'
    + '<style id="dshs-hero-css">' + heroCss + '</style>'
    // 配置脚本要早于 EARLY：EARLY 在"60 秒内重复刷新"时会直接 return，
    // 但档位/节日的类必须每次都挂上（跳过动画不等于连配色都不给）。
    + configScript(config, festival)
    + EARLY
  const tail = '<script defer src="' + BASE + '/boot.js"></script>'
  const opened = html.replace(/<head(\s[^>]*)?>/i, (tag) => tag + head)
  return opened.indexOf('</body>') !== -1
    ? opened.replace('</body>', tail + '</body>')
    : opened + tail
}

// 节日判定是纯函数，单独导出给自检用固定日期跑一遍（日期窗口最容易悄悄失效）
export { activeFestival }

export default {
  name: NAME,
  inject: ['webServer'],
  apply(ctx) {
    const logger = ctx.logger?.(NAME) ?? console
    const bootJs = asset('boot.js')
    const splashCss = asset('boot.css').toString('utf8')
    const wallCss = asset('wallpaper.css').toString('utf8')
    const heroCss = asset('hero.css').toString('utf8')
    const slots = Object.keys(SLOTS)

    ctx.effect(() => {
      const route = (path, handler) => ctx.webServer.register({ kind: 'exact', path, handler })
      const disposers = [
        route(BASE + '/boot.js', (req, res) => send(res, 200, 'application/javascript; charset=utf-8', bootJs)),
        ...slots.map((slot) => route(`${BASE}/${slot}`, (req, res) => {
          const image = imageOf(slot)
          send(res, 200, image.type, image.body)
        })),
        route(BASE + '/images', (req, res) => sendJson(res, 200, imageState())),
        route(BASE + '/config', (req, res) => configRoute(req, res)),
        ...slots.map((slot) => route(`${BASE}/images/${slot}`, (req, res) => upload(slot, req, res))),
        ...slots.map((slot) => route(`${BASE}/images/${slot}/reset`, (req, res) => reset(slot, res))),
        route(BASE + '/preview', (req, res) => {
          const config = readConfig()
          // 设置页按当前主题带上 `?dark=1`：预览页自己是个独立文档，拿不到宿主的主题属性
          const dark = /[?&]dark=1(?:&|$)/.test(String(req.url ?? ''))
          const html = previewPage(splashCss, wallCss, config, activeFestival(config, new Date()), dark)
          send(res, 200, 'text/html; charset=utf-8', Buffer.from(html))
        }),
      ]
      // 配置在每次注入时现读：改完档位/节日，刷新页面就能看到，不用重启宿主
      disposers.push(ctx.webServer.tapIndex((html) => {
        const config = readConfig()
        return inject(html, splashCss, wallCss, heroCss, config, activeFestival(config, new Date()))
      }))
      logger.info(`dsh-startup-animation: 启动动画 + 主界面壁纸已挂载，图片目录 ${DATA_DIR}`)
      return () => {
        for (const dispose of disposers) dispose()
      }
    })
  },
}
