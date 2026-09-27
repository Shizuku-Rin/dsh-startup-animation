/* dsh-startup-animation 的网页半边：在「设置」里加一页，管启动页头像/背景图，以及主界面 hero 的标题。
 *
 * 手写、不打构建：整包就是 window.__ModuleLoader__ 的一个 factory，只 require 平台种子模块里的 react。
 * 交互只走本插件自己的 HTTP 路由（/dsh-startup/images…、/dsh-startup/config、/dsh-startup/preview），
 * 不占 DSH 的 RPC 通道。
 *
 * 页面结构：顶上是一块实时预览（把宿主的预览页塞进 sandbox iframe，换图即重放；
 * 跟着当前主题走浅色 / 暗色两套假界面），然后是「主界面标题」卡片（问候语 / 打字机 /
 * 光标 / 隐藏 logo 与预览版徽章），「侧栏与壁纸透明度」卡片（侧栏不透明度 / 壁纸白纱两个
 * 滑块，浅色与暗色各存一套值、卡片显示当前主题那一套；拖动即时改 `<html>` 上的 CSS 变量、
 * 松手落盘），最后三张卡片分别管头像、背景图与深色壁纸（点选或拖拽上传、可恢复内置默认图）。
 *
 * 设置页之外还顺手改造主界面 hero：把新会话标题「探索未至之境」换成可配置的问候语并逐字打出来，
 * 同时摘掉标题左边的鲸鱼 logo 与右边的「预览版」徽章（见下面的 hero* 函数）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-startup-animation',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useRef } = React

    const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
    const MAX_BYTES = 12 * 1024 * 1024
    const KINDS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

    const SLOTS = [
      {
        slot: 'avatar',
        label: '头像',
        hint: '启动动画正中那张，建议正方形或接近正方形；显示为圆角方框，不会被裁成圆形。',
      },
      {
        slot: 'bg',
        label: '背景图',
        hint: '启动动画的背景，同时也是「浅色主题」下的主界面壁纸；建议横图，界面里会按 cover 铺满。',
      },
      {
        slot: 'bgDark',
        label: '深色壁纸',
        hint: '「暗色主题」下的主界面壁纸。不换的话就跟着上面那张浅色壁纸走（你换了浅色图它也一起变）；换过之后就只影响暗色主题。建议用偏暗的图，配深色白纱文字对比度更稳。',
      },
    ]

    /** 「主界面标题」卡片上的四个开关：配置字段名 → 显示文案。 */
    const CHECK_LABELS = {
      typewriter: '打字机逐字显示',
      cursor: '闪烁光标',
      hideLogo: '隐藏标题旁的 logo',
      hideBadge: '隐藏「预览版」徽章',
    }

    /** 画质档位：值 → 按钮文案 + 一句话说明（说明直接写在卡片上，省得用户猜）。 */
    const FX_TIERS = [
      {
        id: 'eco',
        label: '省电',
        hint: '星尘最少、不撒光点、极光不漂移，也不要指针视差与跟随暖光。核显 / 老机器首选。',
      },
      {
        id: 'standard',
        label: '标准',
        hint: '目前的默认画面：纯合成器动效，帧间隔中位数已经砍到 33ms 的那一版。',
      },
      {
        id: 'fancy',
        label: '华丽',
        hint: '把全屏模糊、极光缩放、暗角呼吸、头像推近与更多粒子加回来。机器够好再选。',
      },
    ]

    /** 节日彩蛋：auto 跟随日期窗口，其余是手动指定（手动主要给"想现在看看"用）。 */
    const FESTIVALS = [
      { id: 'auto', label: '跟随日期（自动）' },
      { id: 'off', label: '关闭' },
      { id: 'sakura', label: '樱花季' },
      { id: 'snow', label: '飘雪' },
      { id: 'newyear', label: '新年' },
      { id: 'birthday', label: '生日' },
    ]
    const FESTIVAL_LABEL = { sakura: '樱花季', snow: '飘雪', newyear: '新年', birthday: '生日' }
    const FESTIVAL_WINDOWS = '自动窗口：樱花 3/20~4/20 · 飘雪 12/1~2/15 · 新年 1/1~1/3'
    const FESTIVAL_MANUAL = '手动选一个＝"现在立刻演这一个"（选「生日」不用先填日期）；填了生日日期后，「跟随日期」会在那天自动演。'

    /** 改了档位/强制动效要立刻反映在页面上（节日配色只在启动页里用，页面上的类刷新后由宿主注入的脚本接手）。 */
    function applySplashClasses(config) {
      const el = document.documentElement
      for (const tier of FX_TIERS) el.classList.toggle('dshs-fx-' + tier.id, config.fx === tier.id)
      el.classList.toggle('dshs-force-motion', config.forceMotion === true)
    }

    /**
     * 侧栏与壁纸的两个透明度旋钮：字段名 → CSS 变量 + 文案 + 说明。
     * 每项都带浅色 / 暗色两套（`key` / `keyDark`、`cssVar` / `cssVarDark`），
     * 卡片只显示"当前主题"那一组，另一组照旧留在 <html> 上，切主题不需要重算。
     * 滑块、数值回显与说明都由这份表驱动，加一项只改这里。
     * 变量名与 lib/index.js 的 configScript、assets/wallpaper.css 里的 `var()` 是一套。
     */
    const WALL_SLIDERS = [
      {
        key: 'sidebarOpacity',
        keyDark: 'sidebarOpacityDark',
        cssVar: '--dshs-sidebar',
        cssVarDark: '--dshs-sidebar-dark',
        fallback: 78,
        fallbackDark: 82,
        label: '侧栏不透明度',
        hint: '左边那一栏底色的不透明度：78%（浅色）/ 82%（暗色）就是原来的样子；调低壁纸在侧栏里更明显（0% 是全透明、壁纸原样透出来），调到 100% 是纯色底、侧栏完全盖住壁纸。macOS 上侧栏本来就是全透明，这一项不起作用。',
      },
      {
        key: 'veilOpacity',
        keyDark: 'veilOpacityDark',
        cssVar: '--dshs-veil',
        cssVarDark: '--dshs-veil-dark',
        fallback: 80,
        fallbackDark: 90,
        label: '壁纸白纱',
        hint: '压在壁纸上的白纱浓度：越大壁纸越淡、文字越清楚；0% 是壁纸原图（花一点的图可能会糊字）。暗色默认 90%，因为深色界面配的是浅色文字，白纱得比浅色那组更浓。启动动画收尾也用同一组值（按主题各取一套）。',
      },
    ]

    /** 百分比夹到 0~100 的整数：缺字段、坏值、越界都吃得住。 */
    function clampPercent(value, fallback) {
      return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : fallback
    }

    /** 当前是不是暗色主题：主题插件把 `data-ds-dark-theme` 挂在 body 上。 */
    function isDarkTheme() {
      return typeof document !== 'undefined' && document.body !== null && document.body.hasAttribute('data-ds-dark-theme')
    }

    /** 一项旋钮在当前主题下的字段名 / 兜底值（卡片与写变量都走这里，免得两处各判一次）。 */
    function slotOf(item, dark) {
      return dark
        ? { key: item.keyDark, cssVar: item.cssVarDark, fallback: item.fallbackDark }
        : { key: item.key, cssVar: item.cssVar, fallback: item.fallback }
    }

    /**
     * 把两套（共四个）透明度写到 `<html>` 的行内样式上：wallpaper.css 用带 fallback 的 `var()` 读，
     * 所以拖完立刻见效、不用刷新；主题切到哪一套由 CSS 自己按 body 的属性挑，这里不用管。
     * 宿主下次渲染页面时（configScript）会写同样四个变量。
     */
    function applyWallpaperVars(config) {
      const el = document.documentElement
      for (const item of WALL_SLIDERS) {
        el.style.setProperty(item.cssVar, String(clampPercent(config[item.key], item.fallback) / 100))
        el.style.setProperty(item.cssVarDark, String(clampPercent(config[item.keyDark], item.fallbackDark) / 100))
      }
    }

    /** 两张配置卡片共用的存盘动作：POST 一份局部配置，返回宿主校验后的完整配置。 */
    async function saveConfig(body) {
      const answered = await fetch('/dsh-startup/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await answered.json()
      if (!data.ok) throw new Error(data.error || '保存失败')
      return data
    }

    const styles = {
      page: { maxWidth: 660, fontSize: 13, color: 'var(--dsw-alias-label-primary, #22303f)' },
      lead: { margin: '0 0 16px', color: 'var(--dsw-alias-label-secondary, #55617a)', lineHeight: 1.7 },
      card: {
        display: 'flex',
        gap: 16,
        alignItems: 'flex-start',
        padding: 16,
        marginBottom: 14,
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: 12,
      },
      previewCard: {
        padding: 16,
        marginBottom: 14,
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: 12,
      },
      previewHead: {
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 10,
        flexWrap: 'wrap',
      },
      previewTitle: { margin: 0, fontSize: 14, fontWeight: 600 },
      frame: {
        display: 'block',
        width: '100%',
        height: 320,
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: 10,
        background: '#f7f1f8',
      },
      frameIdle: {
        display: 'grid',
        placeItems: 'center',
        color: 'var(--dsw-alias-label-tertiary, #8b93a1)',
      },
      thumb: {
        flex: '0 0 96px',
        width: 96,
        height: 96,
        borderRadius: 10,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
      },
      thumbImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
      body: { flex: 1, minWidth: 0 },
      title: { margin: '0 0 4px', fontSize: 14, fontWeight: 600 },
      hint: { margin: '0 0 6px', color: 'var(--dsw-alias-label-tertiary, #8b93a1)', lineHeight: 1.6 },
      meta: { margin: '0 0 10px', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' },
      row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      primary: {
        font: 'inherit',
        cursor: 'pointer',
        border: 'none',
        height: 32,
        padding: '0 14px',
        borderRadius: 999,
        background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f6ef7))',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
      },
      ghost: {
        font: 'inherit',
        cursor: 'pointer',
        height: 32,
        padding: '0 14px',
        borderRadius: 999,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #22303f)',
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
      },
      busy: { opacity: .55, cursor: 'default' },
      err: { margin: '8px 0 0', color: 'var(--dsw-alias-state-error-primary, #dc2626)', lineHeight: 1.6 },
      drop: { outline: '2px dashed var(--dsw-alias-brand-primary, #4f6ef7)', outlineOffset: 2 },
      foot: { margin: '18px 0 0', color: 'var(--dsw-alias-label-tertiary, #8b93a1)', lineHeight: 1.7 },
      mono: { background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', borderRadius: 4, padding: '1px 4px' },
      formCard: {
        padding: 16,
        marginBottom: 14,
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: 12,
      },
      label: { display: 'block', margin: '0 0 6px', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' },
      input: {
        font: 'inherit',
        height: 32,
        padding: '0 10px',
        boxSizing: 'border-box',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'inherit',
      },
      area: {
        font: 'inherit',
        width: '100%',
        minHeight: 58,
        padding: '8px 10px',
        boxSizing: 'border-box',
        resize: 'vertical',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'inherit',
      },
      checks: { display: 'flex', flexWrap: 'wrap', gap: '8px 16px', margin: '14px 0 0' },
      check: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' },
      ok: { margin: '10px 0 0', color: 'var(--dsw-alias-state-success-primary, #16a34a)' },
    }

    /**
     * 一张图的状态文案。`inherited` 是宿主给的：这个槽位没单独设过图，正跟着别的槽位走
     * （暗色壁纸跟随浅色），这时候说"跟随浅色壁纸"比说"内置默认图"准确得多。
     */
    function describe(state) {
      if (!state) return '读取中…'
      const size = Math.max(1, Math.round((state.bytes || 0) / 1024))
      if (state.inherited === true) return `跟随浅色壁纸 · ${size} KB`
      return (state.custom ? '自定义图' : '内置默认图') + ` · ${size} KB`
    }

    /**
     * 图片地址带上 mtime 作为版本号，换图后预览立刻更新。
     * 不再要求 `custom`：跟随浅色的槽位拿的是被继承那张的 mtime，浅色换图时它也得跟着换。
     */
    function imageUrl(slot, state) {
      const version = state && state.mtime ? state.mtime : 0
      return `/dsh-startup/${slot}?v=${version}`
    }

    /** 几张图的版本号拼起来：任何一张换了，预览 iframe 都会重新挂载并重放。 */
    function stamp(state) {
      if (!state) return 'loading'
      return SLOTS.map((item) => {
        const one = state[item.slot]
        return one && one.custom && one.mtime ? one.mtime : 'default'
      }).join('-')
    }

    /** 档位/节日/强制动效也进预览的 key：改完这几项，预览小窗同样要重放一遍。 */
    function splashStamp(config) {
      if (!config) return 'none'
      return [config.fx, config.festival, config.birthday, config.forceMotion ? 'force' : 'calm'].join('_')
    }

    /** 实时预览：宿主把预览页渲染成自包含文档，这里只负责挂载与重播。 */
    function Preview(props) {
      const [nonce, setNonce] = useState(0)
      // 状态读回来之前先不挂 iframe：否则会先播一遍、拿到 mtime 后再重挂播第二遍
      const ready = props.state !== null
      // 预览页是独立文档，拿不到宿主的主题属性，所以按当前主题把 `?dark=1` 带进去：
      // 暗色下用深色假界面 + 壁纸样式里那条暗色分支，看到的就是真实过场
      const theme = props.dark ? '?dark=1' : ''
      return h('div', { style: styles.previewCard }, [
        h('div', { key: 'head', style: styles.previewHead }, [
          h('p', { key: 'title', style: styles.previewTitle }, '实时预览'),
          h('div', { key: 'acts', style: styles.row }, [
            h('button', {
              key: 'again',
              type: 'button',
              style: ready ? styles.ghost : Object.assign({}, styles.ghost, styles.busy),
              disabled: !ready,
              onClick: () => setNonce(nonce + 1),
            }, '重播'),
            h('button', {
              key: 'open',
              type: 'button',
              style: styles.ghost,
              onClick: () => window.open('/dsh-startup/preview' + theme, '_blank', 'noopener'),
            }, '新标签打开'),
          ]),
        ]),
        // sandbox 只给 allow-scripts：预览页拿到的是独立源，既不会碰到真实页面的
        // sessionStorage（否则在预览里看一遍，真页面就会当成"已播过"而跳过动画），
        // 也不会把脚本能力带进设置页。
        ready
          ? h('iframe', {
            key: stamp(props.state) + '-' + splashStamp(props.config) + '-' + (props.dark ? 'dark' : 'light') + '-' + nonce,
            style: styles.frame,
            src: '/dsh-startup/preview' + theme,
            sandbox: 'allow-scripts',
            title: '启动动画预览',
          })
          : h('div', { key: 'idle', style: Object.assign({}, styles.frame, styles.frameIdle) }, '正在读取图片状态…'),
        h('p', { key: 'hint', style: styles.hint }, '换完图、改完档位或节日，这里会自动重放一遍；「新标签打开」可放大看。预览里跑的启动动画与真实开机时完全同一份代码，也会跟着当前主题（浅色 / 暗色）走。'),
      ])
    }

    /**
     * 「启动动画效果」卡片：画质档位 + 强制动效 + 节日彩蛋。
     * 档位与强制动效存盘后立刻挂到 <html> 上；节日配色只用在启动页，刷新后由宿主注入的类接手。
     */
    function SplashCard(props) {
      const [draft, setDraft] = useState(props.config)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [warn, setWarn] = useState(null)
      const [saved, setSaved] = useState(false)

      function patch(key, value) {
        setDraft(Object.assign({}, draft, { [key]: value }))
        setSaved(false)
        setWarn(null)
      }

      async function save(body) {
        setBusy(true)
        setError(null)
        setWarn(null)
        try {
          const data = await saveConfig(body)
          if (data.warning) {
            // 有一项没被接受时**不要**用返回值刷新草稿：那会把用户刚敲的生日冲掉，
            // 看起来就是"保存了但输入框自己变空"。留着让他改，并把原因写在下面。
            setWarn(data.warning)
          } else {
            setDraft(data.config)
            setSaved(true)
          }
          props.onSaved(data.config, data.festival)
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }

      const tier = FX_TIERS.filter((item) => item.id === draft.fx)[0] || FX_TIERS[1]
      const today = props.festival

      return h('div', { style: styles.formCard }, [
        h('p', { key: 'title', style: styles.title }, '启动动画效果'),
        h('p', { key: 'hint', style: styles.hint },
          '画质档位决定开机那两秒撒多少东西；节日彩蛋跟着日期自动换配色与粒子。改完刷新页面，下次播放就是新画面。'),
        h('label', { key: 'fxLabel', style: styles.label }, '画质档位'),
        h('div', { key: 'fx', style: styles.row }, FX_TIERS.map((item) => h('button', {
          key: item.id,
          type: 'button',
          disabled: busy,
          style: draft.fx === item.id
            ? Object.assign({}, styles.primary, busy ? styles.busy : null)
            : Object.assign({}, styles.ghost, busy ? styles.busy : null),
          onClick: () => patch('fx', item.id),
        }, item.label))),
        h('p', { key: 'fxHint', style: Object.assign({}, styles.hint, { marginTop: 8 }) }, tier.hint),
        h('div', { key: 'motion', style: styles.checks }, [
          h('label', { key: 'force', style: styles.check }, [
            h('input', {
              key: 'box',
              type: 'checkbox',
              checked: draft.forceMotion === true,
              disabled: busy,
              onChange: (event) => patch('forceMotion', event.target.checked),
            }),
            '强制播放动效',
          ]),
        ]),
        h('p', { key: 'motionHint', style: styles.hint },
          '勾上它，即使系统开着「减少动态效果」（Windows 的「辅助功能 → 视觉效果 → 动画效果」关了就会这样），星尘、极光、视差也照播。'),
        h('div', { key: 'fest', style: Object.assign({}, styles.row, { marginTop: 14 }) }, [
          h('label', { key: 'festLabel', style: Object.assign({}, styles.label, { margin: 0 }) }, '节日特效'),
          h('select', {
            key: 'festSelect',
            style: styles.input,
            value: draft.festival,
            disabled: busy,
            onChange: (event) => patch('festival', event.target.value),
          }, FESTIVALS.map((item) => h('option', { key: item.id, value: item.id }, item.label))),
          h('label', { key: 'bLabel', style: Object.assign({}, styles.label, { margin: '0 0 0 8px' }) }, '生日'),
          h('input', {
            key: 'birthday',
            type: 'text',
            placeholder: 'MM-DD',
            // 放宽到 10：`2026-12-24` 这种带年份的写法也要能敲进去（宿主会取月日）
            maxLength: 10,
            inputMode: 'numeric',
            style: Object.assign({}, styles.input, { width: 96 }),
            value: draft.birthday,
            disabled: busy,
            onChange: (event) => patch('birthday', event.target.value),
          }),
        ]),
        h('p', { key: 'today', style: Object.assign({}, styles.hint, { marginTop: 8 }) },
          today ? `今天生效：${FESTIVAL_LABEL[today] || today}` : '今天没有节日特效'),
        h('p', { key: 'windows', style: styles.hint }, FESTIVAL_WINDOWS),
        h('p', { key: 'manual', style: styles.hint }, FESTIVAL_MANUAL),
        h('p', { key: 'birthdayHint', style: styles.hint },
          '生日写法很随意：02-14、2-14、2/14、2月14日、0214、2026-12-24 都认，存完会统一显示成 02-14。'),
        h('p', { key: 'replayHint', style: styles.hint },
          '看效果最快的办法：存盘后点「现在重播一次」。普通刷新在 60 秒内会整段跳过动画（免得自动重载一直演），存盘时我会顺手清掉那个标记。'),
        h('div', { key: 'acts', style: Object.assign({}, styles.row, { marginTop: 14 }) }, [
          h('button', {
            key: 'save',
            type: 'button',
            style: busy ? Object.assign({}, styles.primary, styles.busy) : styles.primary,
            disabled: busy,
            onClick: () => save(draft),
          }, busy ? '保存中…' : '保存并生效'),
          h('button', {
            key: 'reset',
            type: 'button',
            style: busy ? Object.assign({}, styles.ghost, styles.busy) : styles.ghost,
            disabled: busy,
            onClick: () => save({ reset: true }),
          }, '恢复默认'),
          h('button', {
            key: 'replay',
            type: 'button',
            style: styles.ghost,
            onClick: props.onReplay,
          }, '现在重播一次'),
          saved ? h('span', { key: 'ok', style: styles.ok }, '已生效 ✓') : null,
        ]),
        warn ? h('p', { key: 'warn', style: styles.err }, warn) : null,
        error ? h('p', { key: 'err', style: styles.err }, error) : null,
      ])
    }

    /**
     * 「侧栏与壁纸透明度」卡片：侧栏不透明度 + 壁纸白纱两个滑块。
     * 浅色 / 暗色各存一套值，卡片显示的是**当前主题**那一套（props.dark 由设置页跟着
     * body 上的 data-ds-dark-theme 传下来）：切主题就换一组，不用来回改。
     * 拖动过程中只改页面上的 CSS 变量（立刻见效、不发请求），松手才落盘 —— 每像素一次 POST 没必要。
     * 宿主没重启过的话配置里根本没有这几个字段（旧版 sanitizeConfig 会把不认识的键丢掉），
     * 所以先探测一次：不认识就整卡禁用并写明原因，免得用户拉半天以为坏了。
     */
    function WallpaperCard(props) {
      const supported = WALL_SLIDERS.every((item) => typeof props.config[item.key] === 'number' && typeof props.config[item.keyDark] === 'number')
      const [draft, setDraft] = useState(props.config)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [saved, setSaved] = useState(false)
      // 松手时要读到最新的草稿：指针事件与 React 的状态更新不在同一个任务里，
      // 与其赌这个时序，不如拖动过程中把最新一份另存下来。
      const latest = useRef(draft)

      // 别的卡片改了配置（最典型的是「恢复默认」）父组件会把新配置传下来，
      // 不跟着同步的话这儿的滑块和页面上的变量就都停在旧值上。
      React.useEffect(() => {
        latest.current = props.config
        setDraft(props.config)
        applyWallpaperVars(props.config)
      }, [props.config])

      function drag(item, value) {
        const slot = slotOf(item, props.dark)
        const next = Object.assign({}, latest.current, { [slot.key]: value })
        latest.current = next
        setDraft(next)
        setSaved(false)
        applyWallpaperVars(next)
      }

      async function save() {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          // 只提交当前主题这一套字段：另一套原样留在配置里，不会被这次保存动到
          const body = {}
          for (const item of WALL_SLIDERS) {
            const slot = slotOf(item, props.dark)
            body[slot.key] = clampPercent(latest.current[slot.key], slot.fallback)
          }
          const data = await saveConfig(body)
          latest.current = data.config
          setDraft(data.config)
          applyWallpaperVars(data.config)
          setSaved(true)
          props.onSaved(data.config)
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }

      // 另一套（另一个主题）当前的值：让"两套分开存"这件事在界面上看得见
      const other = WALL_SLIDERS.map((item) => {
        const slot = slotOf(item, !props.dark)
        return item.label + ' ' + clampPercent(draft[slot.key], slot.fallback) + '%'
      }).join(' · ')

      return h('div', { style: styles.formCard }, [
        h('p', { key: 'title', style: styles.title }, '侧栏与壁纸透明度'),
        h('p', { key: 'hint', style: styles.hint }, supported
          ? '当前编辑「' + (props.dark ? '深色' : '浅色') + '主题」这一套（另一套：' + other + '）；切主题就换一组。拖动即时生效、松手才写盘。'
          : '宿主还是旧版，还没有这两组参数：重启 DSH（让它重新挂载插件）之后，这两个滑块就能用了。'),
        ...WALL_SLIDERS.map((item) => {
          const slot = slotOf(item, props.dark)
          const value = clampPercent(draft[slot.key], slot.fallback)
          return h('div', { key: item.key, style: { marginTop: 12, opacity: supported ? 1 : .5 } }, [
            h('label', {
              key: 'label',
              style: Object.assign({}, styles.label, { display: 'flex', justifyContent: 'space-between' }),
            }, [
              h('span', { key: 'text' }, item.label),
              h('span', { key: 'value' }, value + '%'),
            ]),
            h('input', {
              key: 'range',
              type: 'range',
              min: 0,
              max: 100,
              step: 1,
              value: value,
              disabled: !supported || busy,
              style: { width: '100%', margin: 0 },
              onChange: (event) => drag(item, Number(event.target.value)),
              // 松手（鼠标 / 触摸 / 键盘）才落盘
              onPointerUp: save,
              onKeyUp: save,
              onBlur: save,
            }),
            h('p', { key: 'hint', style: styles.hint }, item.hint),
          ])
        }),
        busy ? h('p', { key: 'busy', style: styles.hint }, '保存中…') : null,
        saved ? h('span', { key: 'ok', style: styles.ok }, '已生效 ✓') : null,
        error ? h('p', { key: 'err', style: styles.err }, error) : null,
      ])
    }

    /**
     * 「主界面标题」卡片：改问候语、打字机、光标与两处隐藏开关。
     * 存盘后立刻回调 onSaved，主界面那边会拿新配置重放一遍（不用刷新就能看到）。
     */
    function HeroCard(props) {
      const [draft, setDraft] = useState(props.config)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [saved, setSaved] = useState(false)

      function patch(key, value) {
        setDraft(Object.assign({}, draft, { [key]: value }))
        setSaved(false)
      }

      async function save(body) {
        setBusy(true)
        setError(null)
        try {
          const data = await saveConfig(body)
          setDraft(data.config)
          setSaved(true)
          props.onSaved(data.config)
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }

      function toggle(key) {
        return h('label', { key, style: styles.check }, [
          h('input', {
            key: 'box',
            type: 'checkbox',
            checked: draft[key] === true,
            disabled: busy,
            onChange: (event) => patch(key, event.target.checked),
          }),
          CHECK_LABELS[key],
        ])
      }

      return h('div', { style: styles.formCard }, [
        h('p', { key: 'title', style: styles.title }, '主界面标题'),
        h('p', { key: 'hint', style: styles.hint },
          '新会话空状态那句标题（原来是「探索未至之境」）。存盘后立刻在主界面生效，不用刷新。'),
        h('label', { key: 'headline', style: styles.label }, '问候语'),
        h('textarea', {
          key: 'text',
          style: styles.area,
          value: draft.headline,
          disabled: busy,
          onChange: (event) => patch('headline', event.target.value),
        }),
        h('div', { key: 'checks', style: styles.checks }, [
          toggle('typewriter'),
          toggle('cursor'),
          toggle('hideLogo'),
          toggle('hideBadge'),
        ]),
        h('div', { key: 'tuning', style: Object.assign({}, styles.row, { marginTop: 14 }) }, [
          h('label', { key: 'speedLabel', style: Object.assign({}, styles.label, { margin: 0 }) }, '每字间隔'),
          h('input', {
            key: 'speed',
            type: 'number',
            min: 10,
            max: 1000,
            step: 10,
            style: Object.assign({}, styles.input, { width: 84 }),
            value: draft.speed,
            disabled: busy || draft.typewriter !== true,
            onChange: (event) => patch('speed', Number(event.target.value)),
          }),
          h('span', { key: 'unit', style: styles.hint }, '毫秒'),
          h('label', { key: 'charLabel', style: Object.assign({}, styles.label, { margin: '0 0 0 8px' }) }, '光标字符'),
          h('input', {
            key: 'char',
            type: 'text',
            maxLength: 4,
            style: Object.assign({}, styles.input, { width: 64 }),
            value: draft.cursorChar,
            disabled: busy || draft.cursor !== true,
            onChange: (event) => patch('cursorChar', event.target.value),
          }),
        ]),
        h('div', { key: 'acts', style: Object.assign({}, styles.row, { marginTop: 14 }) }, [
          h('button', {
            key: 'save',
            type: 'button',
            style: busy ? Object.assign({}, styles.primary, styles.busy) : styles.primary,
            disabled: busy,
            onClick: () => save(draft),
          }, busy ? '保存中…' : '保存并生效'),
          h('button', {
            key: 'reset',
            type: 'button',
            style: busy ? Object.assign({}, styles.ghost, styles.busy) : styles.ghost,
            disabled: busy,
            onClick: () => save({ reset: true }),
          }, '恢复默认'),
          saved ? h('span', { key: 'ok', style: styles.ok }, '已生效 ✓') : null,
        ]),
        error ? h('p', { key: 'err', style: styles.err }, error) : null,
      ])
    }

    function SlotCard(props) {
      const slot = props.slot
      const state = props.state
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [over, setOver] = useState(false)
      const input = useRef(null)

      async function send(file) {
        if (!file) return
        if (KINDS.indexOf(file.type) === -1) {
          setError('只认 PNG / JPEG / WebP / GIF 四种格式')
          return
        }
        if (file.size > MAX_BYTES) {
          setError(`图太大了（${Math.round(file.size / 1024 / 1024)}MB），上限 12MB`)
          return
        }
        setError(null)
        setBusy(true)
        try {
          const answered = await fetch(`/dsh-startup/images/${slot}`, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          })
          const data = await answered.json()
          if (!data.ok) throw new Error(data.error || '保存失败')
          props.onState(data.state)
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
          if (input.current) input.current.value = ''
        }
      }

      async function reset() {
        setError(null)
        setBusy(true)
        try {
          const answered = await fetch(`/dsh-startup/images/${slot}/reset`, { method: 'POST' })
          const data = await answered.json()
          if (!data.ok) throw new Error(data.error || '恢复失败')
          props.onState(data.state)
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }

      return h('div', {
        style: over ? Object.assign({}, styles.card, styles.drop) : styles.card,
        onDragOver: (event) => { event.preventDefault(); setOver(true) },
        onDragLeave: () => setOver(false),
        onDrop: (event) => { event.preventDefault(); setOver(false); send(event.dataTransfer.files[0]) },
      }, [
        h('div', { key: 'thumb', style: styles.thumb },
          h('img', { style: styles.thumbImg, src: imageUrl(slot, state), alt: '' })),
        h('div', { key: 'body', style: styles.body }, [
          h('p', { key: 'title', style: styles.title }, props.label),
          h('p', { key: 'hint', style: styles.hint }, props.hint),
          h('p', { key: 'meta', style: styles.meta }, describe(state)),
          h('div', { key: 'row', style: styles.row }, [
            h('input', {
              key: 'file',
              ref: input,
              type: 'file',
              accept: ACCEPT,
              style: { display: 'none' },
              onChange: (event) => send(event.target.files[0]),
            }),
            h('button', {
              key: 'pick',
              type: 'button',
              style: busy ? Object.assign({}, styles.primary, styles.busy) : styles.primary,
              disabled: busy,
              onClick: () => input.current && input.current.click(),
            }, busy ? '处理中…' : '选择图片'),
            state && state.custom
              ? h('button', {
                key: 'reset',
                type: 'button',
                style: busy ? Object.assign({}, styles.ghost, styles.busy) : styles.ghost,
                disabled: busy,
                onClick: reset,
              }, '恢复默认')
              : null,
          ]),
          error ? h('p', { key: 'err', style: styles.err }, error) : null,
        ]),
      ])
    }

    function SettingsSection() {
      const [state, setState] = useState(null)
      // undefined = 还在读；null = 读失败；对象 = 读到了（失败也占着卡片位置，好让用户知道为什么改不了）
      const [config, setConfig] = useState(undefined)
      const [festival, setFestival] = useState('')
      const [error, setError] = useState(null)
      // 主题可能在设置页开着的时候被切走：跟着 body 上的属性走，透明度卡片与预览都据此换一套
      const [dark, setDark] = useState(isDarkTheme())

      React.useEffect(() => {
        let alive = true
        // 两个接口各读各的：标题配置读不到，不该把换图那两张卡片也一起弄没
        fetch('/dsh-startup/images')
          .then((answered) => answered.json())
          .then((data) => { if (alive) setState(data) })
          .catch((err) => { if (alive) setError(err && err.message ? err.message : String(err)) })
        fetch('/dsh-startup/config')
          .then((answered) => answered.json())
          .then((data) => {
            if (!alive) return
            setConfig(data && data.ok === true ? data.config : null)
            if (data && data.ok === true) {
              setFestival(typeof data.festival === 'string' ? data.festival : '')
              applySplashClasses(data.config)
              applyWallpaperVars(data.config)
            }
          })
          .catch(() => { if (alive) setConfig(null) })
        return () => { alive = false }
      }, [])

      // 主题属性由 dsh-client-ui-theme 挂在 body 上：观察它，深浅两套值各归各位
      React.useEffect(() => {
        if (typeof MutationObserver === 'undefined' || document.body === null) return undefined
        const sync = () => setDark(isDarkTheme())
        sync()
        const observer = new MutationObserver(sync)
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return () => observer.disconnect()
      }, [])

      /** 清掉"刚看过动画"的标记再刷新，这样刷新时启动动画会再播一遍。 */
      function replay() {
        try { sessionStorage.removeItem('dshs-at') } catch (err) { /* 忽略 */ }
        location.reload()
      }

      /** 存盘后主界面那边立刻重放：不用刷新就能看到新文案/新开关的效果。 */
      function heroSaved(next) {
        setConfig(next)
        heroApply(next, true)
      }

      /** 壁纸透明度：存盘后按宿主校验返回的值把两个 CSS 变量重算一遍（越界值以宿主为准）。 */
      function wallpaperSaved(next) {
        setConfig(next)
        applyWallpaperVars(next)
      }

      /** 启动动画那边：档位与强制动效立刻挂到 <html> 上，节日只更新"今天"的显示。
       *  顺手清掉"刚播过"的标记：存盘之后刷新一次就能看到新画面，不用再去找那个按钮。 */
      function splashSaved(next, today) {
        setConfig(next)
        setFestival(today || '')
        applySplashClasses(next)
        try { sessionStorage.removeItem('dshs-at') } catch (err) { /* 忽略 */ }
      }

      return h('div', { style: styles.page, 'data-dshs-ui': '' }, [
        h('p', { key: 'lead', style: styles.lead },
          '换掉打开软件时的启动动画、主界面壁纸（含侧栏那层底色的透明度与壁纸白纱），以及主界面新会话那句标题。',
          '图片支持 PNG / JPEG / WebP / GIF，单张上限 12MB；点「选择图片」或直接把图拖到卡片上，',
          '换完上面的预览会自动重放一遍。'),
        h(Preview, { key: 'preview', state: state, config: config || undefined, dark: dark }),
        config ? h(SplashCard, { key: 'splash', config: config, festival: festival, onSaved: splashSaved, onReplay: replay }) : null,
        config ? h(WallpaperCard, { key: 'wallpaper', config: config, dark: dark, onSaved: wallpaperSaved }) : null,
        config ? h(HeroCard, { key: 'hero', config: config, onSaved: heroSaved }) : h('div', { key: 'hero', style: styles.formCard }, [
          h('p', { key: 'title', style: styles.title }, '主界面标题'),
          h('p', { key: 'hint', style: styles.hint }, config === null
            ? '读不到宿主配置（/dsh-startup/config），所以这里暂时改不了。多半是插件刚更新、宿主还没重新挂载：在插件市场里把它重装一次（或重启 DSH）后再刷新本页即可。'
            : '正在读取配置…'),
        ]),
        // 宿主是旧版时 /dsh-startup/images 里没有 bgDark（也就没有那条路由），硬渲染出来只会是
        // 一张永远"读取中…"+ 404 的卡片：所以状态读回来之后只显示宿主确实报了的槽位
        // （读回来之前先照常渲染，保持原来那两张卡的"读取中…"行为）。
        ...SLOTS.filter((item) => state === null || state[item.slot] !== undefined).map((item) => h(SlotCard, {
          key: item.slot,
          slot: item.slot,
          label: item.label,
          hint: item.hint,
          state: state ? state[item.slot] : null,
          onState: (next) => setState(next),
        })),
        h('div', { key: 'foot', style: styles.row }, [
          h('button', { key: 'replay', type: 'button', style: styles.primary, onClick: replay }, '在真实界面里看一遍'),
          h('button', {
            key: 'reload',
            type: 'button',
            style: styles.ghost,
            onClick: () => location.reload(),
          }, '只刷新页面'),
        ]),
        h('p', { key: 'note', style: styles.foot },
          '「在真实界面里看一遍」会刷新页面并重放启动动画（相当于重新打开软件那一下）；',
          '普通刷新（60 秒内）默认跳过动画，只看壁纸变化。自定义图存在 ',
          h('code', { key: 'path', style: styles.mono }, '$DSH_HOME/dsh-startup-animation/'),
          '，删掉或点「恢复默认」就回到内置图。'),
        error ? h('p', { key: 'err', style: styles.err }, `读取状态失败：${error}`) : null,
      ])
    }

    /* ── 主界面 hero 改造 ────────────────────────────────────────────────
     * 新会话那句标题来自会话组件内置的 i18n 字典（hero.headline），槽位机制碰不到字典，
     * 所以直接在 DOM 上做，四件事：
     *   · 标题换成配置里的问候语，逐字打出来（打字机）；
     *   · 光标用 CSS 的 ::after 画，不往 React 的树里插节点——插进去会被重渲染抹掉；
     *   · 摘掉标题左边的鲸鱼 logo 与右边的「预览版」徽章（按结构找，不认哈希类名）；
     *   · 文案/速度/开关都来自 /dsh-startup/config，设置页存盘后立刻重放。
     * React 重挂载（切新会话）会按字典把原文渲染回来，观察器会再接管一次。
     * 自检脚本在没有 DOM 的 vm 沙箱里执行 apply，所以这里按环境跳过。 */
    const HERO_FROM = '探索未至之境'
    const HERO_MARK = 'data-dshs-hero'
    const HERO_HIDE = 'dshs-hero-hide'
    const HERO_TYPED = 'dshs-hero-typed'
    const HERO_FALLBACK = {
      headline: '你好，我是和栗薰子，欢迎使用Deepseek Harness',
      typewriter: true,
      speed: 70,
      cursor: true,
      cursorChar: '|',
      hideLogo: true,
      hideBadge: true,
    }

    let heroConfig = null

    /** 宿主那份配置可能缺字段（老版本 / 半路升级），补上兜底再上屏。 */
    function heroMerge(config) {
      return Object.assign({}, HERO_FALLBACK, config || {})
    }

    /**
     * 摘掉标题两边的装饰：同一个标题组里的其它孩子是「预览版」徽章，
     * 标题组所在那一排里带 svg 的兄弟是 logo。都按结构找，DSH 换类名也不影响。
     * 开关关掉时用 toggle 把类摘回去，所以设置页改完能立刻看到 logo/徽章回来。
     */
    function heroChrome(title) {
      const group = title.parentElement
      if (group === null) return
      for (const child of group.children) {
        if (child !== title) child.classList.toggle(HERO_HIDE, heroConfig.hideBadge === true)
      }
      const row = group.parentElement
      if (row === null) return
      for (const child of row.children) {
        if (child === group) continue
        if (child.querySelector('svg') !== null) child.classList.toggle(HERO_HIDE, heroConfig.hideLogo === true)
      }
    }

    /**
     * 接管标题：标记 + 装饰 + 逐字打出来。
     * 定时器与状态都挂在元素自身上，所以 React 重挂载出来的新元素会自然从头播一遍。
     */
    function heroType(title) {
      if (title.__dshsTyping === true) return
      const config = heroConfig
      title.setAttribute(HERO_MARK, '')
      title.classList.toggle(HERO_TYPED, config.cursor === true)
      title.style.setProperty('--dshs-hero-cursor', JSON.stringify(config.cursorChar || '|'))
      heroChrome(title)
      if (title.__dshsTimer) { clearInterval(title.__dshsTimer); title.__dshsTimer = 0 }
      const chars = Array.from(config.headline)
      if (config.typewriter !== true) {
        title.textContent = config.headline
        return
      }
      title.__dshsTyping = true
      title.textContent = ''
      let shown = 0
      title.__dshsTimer = setInterval(() => {
        shown += 1
        // 按码点切，问候语里带 emoji 也不会被打成半个字符
        title.textContent = chars.slice(0, shown).join('')
        if (shown >= chars.length) {
          clearInterval(title.__dshsTimer)
          title.__dshsTimer = 0
          title.__dshsTyping = false
        }
      }, Math.max(10, config.speed))
    }

    /**
     * 设置页本身也是这个插件画的，而说明文字里就写着那句原文（「原来是『探索未至之境』」）。
     * 不把这块排除掉的话，观察器会把它当成 hero 标题接管，再按"摘掉标题两边的装饰"把
     * 卡片里的输入框/开关/按钮全藏起来 —— 表现就是"设置里那张卡片只剩一行字，改不了"。
     */
    function inOwnUi(node) {
      const el = node.nodeType === 3 ? node.parentElement : node
      return el !== null && el !== undefined && typeof el.closest === 'function' && el.closest('[data-dshs-ui]') !== null
    }

    /**
     * 从一处 DOM 变动里认出 hero 标题。判定要**整段就是那句原文**（trim 后全等），
     * 不能用"包含"：说明文字里只是提到它，包含判定会把设置页自己误伤。
     */
    function heroScan(node) {
      if (heroConfig === null || node === null || node === undefined) return
      if (inOwnUi(node)) return
      if (node.nodeType === 3) {
        if (node.data.trim() === HERO_FROM && node.parentElement !== null) heroType(node.parentElement)
        return
      }
      // 先廉价地看一眼 textContent，没命中就不往子树里走
      if (node.nodeType !== 1 || node.textContent === null || node.textContent.includes(HERO_FROM) === false) return
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      let text = walker.nextNode()
      while (text !== null) {
        if (text.data.trim() === HERO_FROM && text.parentElement !== null) {
          heroType(text.parentElement)
          return
        }
        text = walker.nextNode()
      }
    }

    /** 配置变了：把已经接管的标题停掉重播；一个都没有就把当前 DOM 扫一遍。 */
    function heroReplay() {
      const marked = document.querySelectorAll('[' + HERO_MARK + ']')
      for (const title of marked) {
        if (title.__dshsTimer) { clearInterval(title.__dshsTimer); title.__dshsTimer = 0 }
        title.__dshsTyping = false
        heroType(title)
      }
      if (marked.length === 0) heroScan(document.body)
    }

    function heroApply(config, replay) {
      heroConfig = heroMerge(config)
      if (replay === true) heroReplay()
    }

    function heroWatch() {
      if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return null
      const host = document.body || document.documentElement
      if (!host) return null
      heroScan(host)   // 已经渲染出来的先接管
      const observer = new MutationObserver((records) => {
        if (heroConfig === null) return
        for (const record of records) {
          if (record.type === 'characterData') { heroScan(record.target); continue }
          for (const added of record.addedNodes) heroScan(added)
        }
        // React 重渲染会把 logo/徽章重新建出来，所以每轮变动后按标记把装饰补一遍
        for (const title of document.querySelectorAll('[' + HERO_MARK + ']')) heroChrome(title)
      })
      observer.observe(host, { subtree: true, childList: true, characterData: true })
      return observer
    }

    /** 页面侧拉一次配置；拿不到就什么都不做——宁可不改，也别用半份配置把标题改坏。 */
    function heroLoad() {
      // 自检脚本在没有 fetch / DOM 的 vm 沙箱里执行 apply，这里按环境跳过
      if (typeof fetch !== 'function') return
      fetch('/dsh-startup/config')
        .then((answered) => answered.json())
        .then((data) => { if (data && data.ok === true) heroApply(data.config, true) })
        .catch(() => {})
    }

    function apply(ctx) {
      // 客户端 HMR 重载会重跑 apply：先撤旧观察器再挂新的——既不叠加，
      // 改了配置也能随热更立刻生效（旧观察器还揣着旧配置，留着会抢着改回去）
      if (window.__dshsHeroWatch) window.__dshsHeroWatch.disconnect()
      window.__dshsHeroWatch = heroWatch()
      heroLoad()
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'startup-animation',
          order: 3,
          label: () => '启动动画与壁纸',
        },
        SettingsSection,
      ))
    }

    return { name: 'dsh-startup-animation', inject: ['slots'], apply }
  },
})
