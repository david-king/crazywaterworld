import { exactAutomationId } from './automation-policy.mjs';

// A complete snapshot must account for the server total with unique report IDs.
// On a changed list, retry once from the beginning without merging snapshots.
export async function readReportSnapshot(client, enabled = () => true) {
  const scan = async () => {
    const reports = new Map();
    let total;
    const partial = (pageNo, reason) => ({
      reports, total, complete: false,
      reason: `战报列表仅读取 ${reports.size}/${total} 条（第 ${pageNo + 1} 页${reason}）`,
    });
    for (let pageNo = 0; ; pageNo++) {
      if (!enabled()) throw Error('战报领取已暂停');
      const page = await client.request('CampaignReportsRequest', { pageNo }, 'CampaignReportsResponse');
      if (!Array.isArray(page?.reports) || !Number.isSafeInteger(page.total) || page.total < 0)
        throw Error('战报列表或总数未完整返回');
      total ??= page.total;
      if (page.total !== total) return partial(pageNo, '总数发生变化');
      const entries = new Map();
      for (const row of page.reports) {
        const id = exactAutomationId(row?.uid);
        if (!id || typeof row.received !== 'boolean') throw Error('战报编号或领取状态未确认');
        if (reports.has(id) || entries.has(id)) return partial(pageNo, '出现重复编号');
        entries.set(id, row);
      }
      for (const [id, row] of entries) reports.set(id, row);
      if (reports.size > total) throw Error('战报总数与列表不一致');
      if (reports.size === total) return { reports, total, complete: true };
      if (!entries.size) return partial(pageNo, '返回空列表');
    }
  };
  const first = await scan();
  return first.complete ? first : scan();
}
