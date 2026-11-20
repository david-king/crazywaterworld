import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "./button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "./card"
import { Input } from "./input"
import { NativeSelect } from "./native-select"
import { HelpTip } from "./help-tip"

export function action(id: string, label: string, variant: React.ComponentProps<typeof Button>["variant"] = "outline", disabled = false) {
  return renderToStaticMarkup(<Button id={id} variant={variant} disabled={disabled}>{label}</Button>)
}

export function stagePanel() {
  return renderToStaticMarkup(
    <div className="grid gap-3">
    <Card>
      <CardHeader>
        <CardTitle className="title-with-help">主线 / 闯关<HelpTip title="主线 / 闯关">点击开始后连续挑战，每场间隔5秒，同一关连续战败达到本页设置后停止，通关清零。这里的手动参数独立于挂机配置，不会开启每轮挂机。</HelpTip><span id="stage-view" className="heading-status" role="status" aria-live="polite">未同步</span></CardTitle>
      </CardHeader>
      <CardContent>
        <div className="bar">
          <div id="stage-lineup-control" className="bar"><span>挑战阵容</span></div>
          <label htmlFor="stage-failures">失败停止次数</label>
          <Input id="stage-failures" aria-label="主线手动挑战失败停止次数" className="w-20" type="number" min="1" defaultValue="3" />
          <Button id="stage-start" disabled>开始连续挑战</Button>
          <Button id="stage-stop" variant="outline" disabled>停止挑战</Button>
        </div>

      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle className="title-with-help">试炼副本<HelpTip title="试炼副本">“挑战一次”只挑战下一关；“开始连续挑战”由你手动开始，达到本页设置的失败停止次数后停止。手动参数与挂机配置独立，扫荡次数另计。</HelpTip></CardTitle><CardAction className="row-span-1 self-center"><Button id="trial-refresh" variant="outline" size="sm">刷新试炼进度</Button></CardAction></CardHeader>
      <CardContent>
        <div id="trial-view" className="progression-view" aria-live="polite" />
      </CardContent>
    </Card>
    <Card><CardHeader><CardTitle>海盗首杀</CardTitle><CardAction><Button id="pirate-manual-refresh" variant="outline" size="sm">刷新目标与舰队</Button></CardAction></CardHeader><CardContent>
      <div className="bar pirate-manual-choices">
        <label className="choice-field"><span>海盗目标</span><NativeSelect id="pirate-manual-target" size="sm" disabled required><option value="">请选择海盗目标</option></NativeSelect></label>
        <label className="choice-field"><span>出征舰队</span><NativeSelect id="pirate-manual-fleet" size="sm" disabled required><option value="">请选择出征舰队</option></NativeSelect></label>
        <label className="choice-field"><span>出战阵容</span><NativeSelect id="pirate-manual-lineup" size="sm"><option value="">使用舰队当前阵容</option></NativeSelect></label>
        <Button id="pirate-manual-lineup-view" variant="outline" size="sm" disabled>查看阵容</Button>
      </div>
      <div id="pirate-manual-view" className="dim" role="status" />
      <div className="bar pirate-manual-actions">
        <label>连续战败上限<Input id="pirate-manual-failures" className="w-20" type="number" min="1" max="100" defaultValue="1" required /></label>
        <label>检查间隔（秒）<Input id="pirate-manual-interval" className="w-20" type="number" min="5" max="60" defaultValue="15" required /></label>
        <Button id="pirate-manual-once" disabled>挑战一次</Button><Button id="pirate-advance-start" variant="outline" disabled>开始连续挑战</Button><Button id="pirate-advance-stop" variant="outline" disabled>停止挑战</Button>
      </div>
      <p id="pirate-advance-state" role="status" hidden />
    </CardContent></Card>
    </div>
  )
}
export * from "./layout"
export * from "./pages"
export * from "./settings"
