import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Boxes, Building2, CalendarDays, Check, ChevronDown, CircleUserRound, Download, GripVertical, LayoutDashboard, Monitor, Moon, MoreHorizontal, RefreshCw, ScrollText, Search, Settings2, Ship, Sun, Swords, UsersRound, X } from "lucide-react"
import { Button } from "./button"
import { Badge } from "./badge"
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "./card"
import { DialogFooter, DialogHeader, DialogTitle } from "./dialog"
import { NativeSelect } from "./native-select"
import { Input } from "./input"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./table"
import { LOG_GROUPS } from "../log-categories.mjs"

// 手机底栏使用短名。
const tabs = [
  ["overview", "总览", "总览", LayoutDashboard],
  ["settings", "挂机配置", "配置", Settings2], ["manual", "建筑一览", "建筑", Building2],
  ["stages", "挑战", "挑战", Swords], ["lineups", "阵容", "阵容", UsersRound],
  ["activities", "活动", "活动", CalendarDays], ["resources", "杂项", "杂项", Boxes],
  ["account", "账号", "账号", CircleUserRound],
] as const

const themes = [["system", "跟随系统", Monitor], ["light", "白天", Sun], ["dark", "黑夜", Moon]] as const

export function chrome() {
  return renderToStaticMarkup(<header>
    <div className="headline">
      <div className="mast">
        <span className="mast-icon"><Ship aria-hidden="true" /></span><h1>疯狂水世界</h1><span className="brand-label">航行控制台</span>
        <Button id="console-version-open" type="button" variant="outline" size="sm" hidden aria-haspopup="dialog" aria-controls="console-version-warning"><RefreshCw aria-hidden="true" />页面已过期</Button>
      </div>
      <div className="connection">
        <span id="busy" className="sr-only" role="status" aria-live="polite" aria-atomic="true">未连接</span>
        <label className="account-label" htmlFor="account-picker-trigger">当前账号</label>
        <div id="account-picker" className="account-picker">
          <select id="account" hidden aria-hidden="true" tabIndex={-1} />
          <Button id="account-picker-trigger" type="button" variant="outline" className="w-full min-w-0 justify-start font-normal" aria-haspopup="listbox" aria-controls="account-picker-list" aria-expanded="false" title="选择账号并查看状态">
            <span id="account-picker-title" className="min-w-0 flex-1 truncate text-left">选择账号</span>
            <Badge id="account-picker-status" className="chip rounded-md" variant="outline">未连接</Badge>
            <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
          </Button>
          <div id="account-picker-list" role="listbox" aria-label="选择账号" hidden />
        </div>
        <Button id="connect" size="sm">连接</Button>
        <div className="hosting-controls">
          <label className="hosting-interval" htmlFor="loop-every"><span className="hosting-interval-label">间隔</span><Input id="loop-every" className="h-8 w-20" type="number" min="1" max="86400" step="1" required defaultValue="60" disabled aria-label="挂机间隔（秒）" aria-describedby="loop-interval-status" title="挂机间隔（秒），按账号自动保存，下一轮使用新间隔" /><span>秒</span></label>
          <Button id="loop-toggle" size="sm" variant="outline" disabled title="按已保存的任务持续挂机，直到手动暂停">开始挂机</Button>
          <Button id="account-pause" size="sm" variant="outline" disabled title="按已保存的任务开始持续托管">开始托管</Button>
          <Button id="logs-open" size="sm" variant="outline" aria-haspopup="dialog" aria-controls="journal-dialog"><ScrollText aria-hidden="true" />日志 <span id="log-top-count">0</span></Button>
          <span id="loop-interval-status" className="sr-only" role="status" />
          <span id="loop-hint" className="sr-only" role="status" />
        </div>
        <Button id="console-quick-open" type="button" size="icon-sm" variant="outline" className="pointer-coarse:size-10" aria-label="站内搜索" title="站内搜索（Ctrl / ⌘ + K）" aria-keyshortcuts="Control+k Meta+k" aria-haspopup="dialog" aria-controls="console-quick-dialog"><Search aria-hidden="true" /></Button>
        <div id="theme-picker" className="theme-picker">
          <Button id="theme-trigger" type="button" size="icon-sm" variant="outline" className="pointer-coarse:size-10" aria-label="切换主题，当前为跟随系统" title="切换主题，当前为跟随系统" aria-haspopup="menu" aria-controls="theme-menu" aria-expanded="false">
            {themes.map(([mode, , Icon]) => <span key={mode} data-theme-icon={mode} hidden={mode !== "system"}><Icon aria-hidden="true" /></span>)}
          </Button>
          <div id="theme-menu" role="menu" aria-label="主题模式" className="absolute right-0 top-full z-50 mt-1.5 w-36 rounded-md border bg-popover p-1 text-popover-foreground shadow-md" hidden>
            {themes.map(([mode, label, Icon]) => <Button key={mode} type="button" variant="ghost" size="sm" role="menuitemradio" aria-checked={mode === "system"} data-theme-option={mode} tabIndex={-1} className="w-full justify-start aria-checked:bg-accent">
              <Icon aria-hidden="true" /><span className="flex-1 text-left">{label}</span><span data-theme-check="" hidden={mode !== "system"}><Check aria-hidden="true" /></span>
            </Button>)}
          </div>
        </div>
      </div>
    </div>
    <nav id="tabs" aria-label="功能导航">{tabs.map(([key, title, short, Icon]) =>
      <button type="button" key={key} className="nav-tab" data-tab={key} aria-label={title} aria-current={key === "overview" ? "page" : undefined}><Icon aria-hidden="true" /><span className="nav-full">{title}</span><span className="nav-short" aria-hidden="true">{short}</span></button>
    )}</nav>
    <div id="page-progress" aria-hidden="true" />
  </header>)
}

export function journal() {
  return renderToStaticMarkup(<dialog id="journal-dialog" aria-label="运行日志"><aside id="journal" aria-label="运行日志">
    <DialogHeader><DialogTitle className="journal-title">运行日志<Badge id="log-count">0</Badge></DialogTitle></DialogHeader>
    <Button id="logs-close" size="icon-sm" variant="ghost" aria-label="关闭运行日志"><X aria-hidden="true" /></Button>
    <div className="log-filter-row"><span className="log-filter-label" id="log-features-label">功能</span><div id="log-tabs" className="log-tags" role="tablist" aria-labelledby="log-features-label">
      <button type="button" id="log-tab-all" className="log-tag log-group-tag" data-tone="neutral" role="tab" data-log-feature="all" aria-selected="true" aria-controls="log-panel"><span>全部</span><span data-log-feature-count="">0</span></button>
    </div></div>
    <div className="log-filter-row"><span className="log-filter-label" id="log-accounts-label">账号</span><div id="log-account-tabs" className="log-tags" role="group" aria-labelledby="log-accounts-label">
      <button type="button" className="log-tag log-group-tag log-account-filter" data-tone="neutral" data-log-account="all" aria-pressed="true" aria-controls="log-panel"><span data-log-account-name="">全部</span><span data-log-account-count="">0</span></button>
    </div></div>
    <div className="log-actions">
      <NativeSelect size="sm" id="log-group" aria-label="日志分类" aria-controls="log-panel">
        <option value="all">全部分类</option>
        {Object.keys(LOG_GROUPS).map(name => <option key={name} value={name}>{name}</option>)}
      </NativeSelect>
      <div className="log-filter" role="group" aria-label="日志筛选">
        <button type="button" id="log-all" aria-pressed="true">全部</button>
        <button type="button" id="log-issues" aria-pressed="false">警告与错误</button>
      </div>
      <Button id="log-clear" size="sm" variant="outline" aria-label="清空全部账号和系统的运行日志" title="清空全部账号和系统的运行日志（包含被筛选隐藏的记录）">清空</Button>
    </div>
    <div id="log-panel" role="tabpanel" aria-labelledby="log-tab-all" tabIndex={0}>
      <div id="log" role="log" aria-live="polite" aria-label="操作记录" />
      <p id="log-empty">还没有运行记录</p>
    </div>
  </aside></dialog>)
}

export function dialogs() {
  return renderToStaticMarkup(<>
    <dialog id="console-quick-dialog" aria-labelledby="console-quick-title">
      <DialogHeader className="flex-row items-center justify-between"><DialogTitle id="console-quick-title">站内搜索</DialogTitle><Button type="button" id="console-quick-close" size="icon-sm" variant="ghost" aria-label="关闭站内搜索"><X aria-hidden="true" /></Button></DialogHeader>
      <Input id="console-quick-query" type="search" role="combobox" aria-label="搜索功能或页面文字" placeholder="搜索功能或页面文字" autoComplete="off" aria-autocomplete="list" aria-controls="console-quick-results" aria-expanded="true" />
      <div id="console-quick-results" role="listbox" aria-label="搜索结果" />
      <p id="console-quick-empty" className="dim" role="status" hidden>没有找到匹配的结果</p>
      <p className="dim for-mouse">↑ ↓ 选择 · Enter 跳转 · Esc 关闭</p>
    </dialog>
    <dialog id="console-version-warning" aria-labelledby="console-version-title" aria-describedby="console-version-description">
      <DialogHeader>
        <DialogTitle id="console-version-title" tabIndex={-1} autoFocus>需要刷新控制台</DialogTitle>
        <p id="console-version-description" className="dim">控制台已更新或重启。刷新后可继续保存修改和启动任务。</p>
      </DialogHeader>
      <div className="version-draft">
        <p>刷新会丢弃本页未保存的修改。需要保留时，可先返回页面复制内容。</p>
        <Button id="console-version-download" type="button" variant="outline" size="sm"><Download aria-hidden="true" />下载游戏配置草稿</Button>
      </div>
      <details id="console-version-account">
        <summary>当前账号操作</summary>
        <div className="bar">
          <Button id="console-version-stop" type="button" variant="outline" size="sm">停止当前账号挂机</Button>
          <Button id="console-version-disconnect" type="button" variant="outline" size="sm">断开当前账号</Button>
        </div>
        <p id="console-version-result" role="status" className="dim" />
      </details>
      <div className="version-footer">
        <Button type="button" id="console-version-dismiss" variant="outline">返回页面</Button>
        <Button type="button" id="console-version-reload">刷新页面</Button>
      </div>
    </dialog>
    <dialog id="guild-tech-upgrade-dialog" aria-labelledby="guild-tech-upgrade-title" aria-describedby="guild-tech-levels">
      <DialogHeader>
        <DialogTitle id="guild-tech-upgrade-title" />
        <p id="guild-tech-levels" className="dim" />
      </DialogHeader>
      <form id="guild-tech-upgrade-form">
        <div id="guild-tech-target-field" className="guild-tech-target-field">
          <label htmlFor="guild-tech-target">目标等级</label>
          <Input id="guild-tech-target" type="number" step="1" required />
          <Button id="guild-tech-highest" type="button" variant="outline" size="sm" />
        </div>
        <dl className="guild-tech-quote">
          <div><dt>预计消耗</dt><dd id="guild-tech-estimate" /></div>
          <div><dt id="guild-tech-balance-label">当前余额</dt><dd id="guild-tech-balance" /></div>
        </dl>
        <p id="guild-tech-feedback" className="dim" role="status" />
        <div className="guild-tech-dialog-actions">
          <Button id="guild-tech-dismiss" type="button" variant="outline">取消</Button>
          <Button id="guild-tech-submit" type="submit">开始升级</Button>
        </div>
      </form>
    </dialog>
    <dialog id="modal" aria-labelledby="m-title">
      <DialogHeader><DialogTitle id="m-title" /></DialogHeader>
      <div id="m-body" />
      <DialogFooter><Button id="m-ok">确认</Button><Button id="m-cancel" variant="outline">取消</Button></DialogFooter>
    </dialog>
    <dialog id="account-dialog" aria-labelledby="account-title"><form method="dialog">
      <DialogHeader><DialogTitle id="account-title" /><p id="account-message" className="dim" /></DialogHeader>
      <Input id="account-label-input" aria-label="账号备注" />
      <DialogFooter><Button value="ok">确认</Button><Button value="cancel" variant="outline">取消</Button></DialogFooter>
    </form></dialog>
    <div id="ui-help-popover" className="help-popover" role="dialog" aria-modal="false" aria-labelledby="ui-help-title" tabIndex={-1} hidden>
      <div className="help-popover-head"><strong id="ui-help-title">说明</strong><Button id="ui-help-close" size="icon-xs" variant="ghost" aria-label="关闭说明"><X aria-hidden="true" /></Button></div>
      <div id="ui-help-body" />
    </div>
  </>)
}

// Clone these rendered components for data that arrives after the initial page.
export function templates() {
  return renderToStaticMarkup(<>
    <template id="ui-table"><Table><TableHeader><TableRow><TableHead /></TableRow></TableHeader><TableBody><TableRow><TableCell /></TableRow></TableBody></Table></template>
    <template id="ui-button"><Button variant="outline" size="sm" /></template>
    <template id="ui-primary"><Button size="sm" /></template>
    <template id="ui-building-card"><Card><CardHeader className="flex-row flex items-center justify-between"><CardTitle><h2 /></CardTitle></CardHeader><CardContent /></Card></template>
    <template id="ui-factory-toggle"><Button type="button" variant="ghost" size="sm" className="factory-toggle -ml-1 justify-start px-1 has-[>svg]:px-1"><ChevronDown aria-hidden="true" className="size-3.5" /></Button></template>
    <template id="ui-confirm"><Button size="sm" /></template>
    <template id="ui-select"><NativeSelect size="sm" /></template>
    <template id="ui-number"><Input type="number" /></template>
    <template id="ui-refill">
      <Card className="gap-0 overflow-hidden py-0 max-md:gap-0 max-md:py-0">
        <div data-refill-rules="" className="divide-y empty:hidden" />
        <div className="config-refill-add bg-muted/30">
          <NativeSelect size="sm" aria-label="选择补库工厂" />
          <NativeSelect size="sm" aria-label="选择要添加的物品" />
          <Button type="button" variant="outline" size="sm" disabled>添加补库规则</Button>
        </div>
      </Card>
    </template>
    <template id="ui-refill-factory">
      <section role="group">
        <div className="flex flex-wrap items-baseline gap-x-3 bg-muted/30 px-3 py-2 sm:px-4">
          <h4 data-refill-factory-name="" className="text-sm" />
          <span data-refill-order-hint="" className="text-xs text-muted-foreground" hidden>同时缺货时，从上到下生产</span>
        </div>
        <div data-refill-products="" className="divide-y" />
      </section>
    </template>
    <template id="ui-refill-rule">
      <fieldset className="config-dispatch-sortable min-w-0 px-3 py-2 sm:px-4">
        <div className="config-refill-line">
          <div className="config-refill-product flex min-w-0 max-w-full items-center gap-2">
            <Button type="button" variant="ghost" size="icon-sm" className="config-dispatch-handle text-muted-foreground pointer-coarse:size-11" data-refill-handle="" hidden><GripVertical aria-hidden="true" /></Button>
            <NativeSelect size="sm" aria-label="补库物品" />
            <span data-refill-rank="" hidden />
          </div>
          <div className="config-refill-fields">
            <label><span className="text-xs text-muted-foreground">库存 ≤</span><Input type="number" inputMode="numeric" min="0" step="1" required data-quantity="trigger" /></label>
            <label><span className="text-xs text-muted-foreground">补至库存</span><Input type="number" inputMode="numeric" min="1" step="1" placeholder="仓容上限" data-quantity="target" /></label>
          </div>
          <div className="flex items-center justify-self-end gap-1">
            <Button type="button" variant="outline" size="sm" data-refill-move="-1" hidden>上移</Button>
            <Button type="button" variant="outline" size="sm" data-refill-move="1" hidden>下移</Button>
            <Button type="button" variant="ghost" size="sm" data-refill-remove="" className="text-muted-foreground hover:text-destructive">移除</Button>
          </div>
        </div>
      </fieldset>
    </template>
    <template id="ui-delete"><Button variant="destructive" size="sm" /></template>
    <template id="ui-badge"><Badge variant="outline" /></template>
    <template id="ui-log-badge"><Badge variant="outline" className="log-tag max-w-full justify-start text-left" /></template>
    <template id="ui-log-account"><button type="button" className="log-tag log-account"><CircleUserRound aria-hidden="true" className="size-3" /><span className="log-account-name" /></button></template>
    <template id="ui-log-account-filter"><button type="button" className="log-tag log-group-tag log-account-filter" data-tone="neutral" aria-pressed="false" aria-controls="log-panel" tabIndex={-1}><span data-log-account-name="" /><span data-log-account-count="">0</span></button></template>
    <template id="ui-account-option">
      <Button type="button" variant="ghost" role="option" tabIndex={-1} aria-selected="false" className="account-picker-option grid h-auto pointer-coarse:h-auto w-full min-w-0 items-start justify-start gap-x-3 gap-y-1 rounded-sm px-3 py-2.5 whitespace-normal text-left font-normal">
        <span data-picker-field="title" />
        <Badge data-picker-field="status" className="chip rounded-md max-w-full justify-start whitespace-normal text-left" variant="outline" />
        <span data-picker-field="check" aria-hidden="true" hidden><Check className="size-4" /></span>
      </Button>
    </template>
    <template id="ui-account-card">
      <Card className="account-card gap-3 py-4 max-md:gap-3">
        <CardHeader className="grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0 px-4">
          <div className="account-card-heading">
            <CardTitle className="leading-normal" data-account-field="title" tabIndex={-1} />
            <Badge data-account-field="status" className="chip rounded-md max-w-full whitespace-normal text-left" variant="outline" />
            <Badge data-account-field="current" variant="secondary" hidden>当前</Badge>
          </div>
          <details className="account-card-menu col-start-2 row-span-2 row-start-1">
            <summary aria-label="更多账号操作"><MoreHorizontal aria-hidden="true" /></summary>
            <div className="account-menu-content">
              <Button type="button" variant="ghost" size="sm" className="h-7 w-full justify-start px-2.5" data-account-action="exclusive" title="暂停同账号其他角色并托管此角色" hidden>切换并托管</Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 w-full justify-start px-2.5" data-account-action="rename">修改备注</Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 w-full justify-start px-2.5" data-account-action="export">导出账号</Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 w-full justify-start px-2.5 text-destructive" data-account-action="remove">移除账号</Button>
            </div>
          </details>
          <p className="dim" data-account-field="channel" />
        </CardHeader>
        <CardContent className="px-4">
          <dl className="account-card-data">
            <div><dt>角色</dt><dd data-account-field="role" /></div>
            <div><dt>等级</dt><dd data-account-field="level" /></div>
            <div><dt>战力</dt><dd data-account-field="power" /></div>
            <div><dt>区服</dt><dd data-account-field="world" /></div>
            <div className="basis-full"><dt>闯关挂机收益</dt><dd data-account-field="afk" /></div>
          </dl>
          <div className="account-resources">
            <div className="account-resources-heading">
              <h3>资源</h3>
              <Button type="button" size="sm" variant="ghost" data-account-action="refresh">刷新资料</Button>
            </div>
            <div className="resource-strip" data-account-field="resources" />
          </div>
        </CardContent>
        <CardFooter className="account-card-footer items-stretch px-4">
          <p className="dim" data-account-field="seen" />
          <div className="account-card-actions">
            <Button type="button" variant="outline" size="sm" className="px-1 text-xs sm:px-1.5 sm:text-sm" data-account-action="worlds" aria-haspopup="dialog" aria-controls="account-worlds-dialog">区服管理</Button>
            <Button type="button" variant="outline" size="sm" className="px-1 text-xs sm:px-1.5 sm:text-sm" data-account-action="login-settings" aria-haspopup="dialog" aria-controls="account-login-dialog">登录设置</Button>
            <Button type="button" variant="outline" size="sm" className="px-1 text-xs sm:px-1.5 sm:text-sm" data-account-action="select">切换账号</Button>
            <Button type="button" size="sm" className="px-1 text-xs sm:px-1.5 sm:text-sm" data-account-action="loop">开始挂机</Button>
          </div>
        </CardFooter>
      </Card>
    </template>
  </>)
}
