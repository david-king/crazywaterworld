import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "./button"
import { HelpTip } from "./help-tip"

export function settingsPage() {
  return renderToStaticMarkup(<div id="config-root">
    <div className="config-toolbar">
      <div className="config-owner"><div className="title-with-help"><strong id="config-account-name">当前账号的挂机配置</strong><HelpTip title="挂机配置">各模块的挂机开关与执行细项、策略、权限和参数统一在对应配置中设置。关闭模块会保留已选细项。修改后自动保存，无需点击保存。停止输入约0.6秒后提交，校验失败会提示修正。只更新当前账号，不会启动挂机；已有挂机在下次检查时使用新设置。全局挂机启停和间隔在页头控制。</HelpTip></div><span id="config-state" role="status" aria-live="polite">尚未载入</span></div>
      <div className="config-actions">
        <Button id="config-history-save" aria-haspopup="dialog" aria-controls="config-history-dialog" type="button" size="sm" variant="outline" disabled>保存快照</Button>
        <Button id="config-history-open" aria-haspopup="dialog" aria-controls="config-history-dialog" type="button" size="sm" variant="outline" disabled>历史配置</Button>
        <Button id="config-import" type="button" size="sm" variant="outline" disabled>导入</Button>
        <Button id="config-export" type="button" size="sm" variant="outline" disabled>导出</Button>
        <Button id="config-retry" type="button" size="sm" variant="outline" hidden disabled>重试自动保存</Button>
        <input id="config-file" type="file" accept=".json,application/json" hidden />
      </div>
    </div>
    <dialog id="config-history-dialog" aria-labelledby="config-history-title">
      <h2 id="config-history-title">历史配置</h2>
      <p id="config-history-status" role="status" />
      <div id="config-history-body" />
      <div id="config-history-actions" />
    </dialog>
    <div className="config-message" id="config-message" role="alert" hidden />
    <div className="config-tabs" role="tablist" aria-label="配置分类">
      {[["base", "基地"], ["world", "世界"], ["heroes", "英雄"], ["antique", "藏品"], ["equipment", "装备"], ["daily", "日常"]].map(([key, title], index) =>
        <button key={key} type="button" role="tab" id={"config-tab-" + key} data-config-tab={key} aria-controls={"config-panel-" + key} aria-selected={index === 0} tabIndex={index === 0 ? 0 : -1}>{title}</button>
      )}
    </div>
    <form id="config-form" noValidate>
      <div id="config-fields" className="config-sheet"><p className="config-empty">载入当前账号后即可设置。</p></div>
    </form>
    <section id="config-weekly-ranking" className="config-preview config-ranking" aria-labelledby="config-weekly-ranking-title" hidden>
      <div className="config-preview-head"><div className="title-with-help"><h3 id="config-weekly-ranking-title">军备竞赛排行</h3><HelpTip title="军备竞赛排行">只读显示服务器当前返回的榜单和本人数据。进入本页时更新，30秒内切回使用缓存；点击刷新榜单可立即重新读取，不改变挂机配置。</HelpTip></div><Button id="config-weekly-ranking-refresh" type="button" size="sm" variant="outline">刷新榜单</Button></div>
      <p id="config-weekly-ranking-status" className="config-help" role="status" aria-live="polite">进入军备竞赛后读取榜单。</p>
      <div id="config-weekly-ranking-summary" className="config-ranking-summary" hidden />
      <p id="config-weekly-ranking-updated" className="config-help" hidden />
      <div id="config-weekly-ranking-table" className="config-ranking-scroll" role="region" aria-label="军备竞赛服务端榜单，可横向滚动" tabIndex={0} hidden />
    </section>
    <section className="config-preview" aria-labelledby="config-preview-title">
      <div className="config-preview-head">
        <div className="title-with-help"><h3 id="config-preview-title">运行预览</h3><HelpTip title="运行预览">默认显示本页最近的挂机检查。点击「只读预览」可查看当前设置下的可排动作、检查条件和具体原因。</HelpTip></div>
        <Button id="config-preview" type="button" size="sm" variant="outline" aria-label="只读预览计划" disabled>只读预览</Button>
      </div>
      <div id="config-preview-summary" role="status" />
      <div id="config-preview-result" aria-live="polite" />
      <div id="config-usage" />
    </section>
    <template id="config-switch-template"><button type="button" role="switch" aria-checked="false" data-state="unchecked" className="config-switch"><span className="config-switch-track" aria-hidden="true"><span className="config-switch-thumb" /></span></button></template>
  </div>)
}
