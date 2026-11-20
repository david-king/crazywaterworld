const groups = {
  materials: '缺材料', population: '人口不足', level: '角色等级不足',
  prerequisite: '前置建筑等级不足', capacity: '人口上限', construction: '施工中',
  maximum: '已满级', config: '配置缺失',
};
const byBuilding = new Intl.Collator('zh-CN', { numeric: true });

export function upgradeReason(row) {
  const { name, kind, required, current } = row;
  switch (kind) {
    case 'materials': return name + '缺' + row.items.map(item => item.name + ' ×' + item.missing).join('、');
    case 'population': return `${name}需要人口 ${required}，当前 ${current}`;
    case 'level': return `${name}需要角色 ${required} 级`;
    case 'prerequisite': return `${name}需要${row.prerequisite}达到 ${required} 级`;
    case 'capacity': return name + '升级后人口超过上限 ' + required;
    case 'construction': return name + '已有施工任务，本轮先检查竣工';
    case 'maximum': return name + '已达最高 ' + required + ' 级';
    case 'config': return name + row.reason;
  }
}

export function summarizeUpgradeChecks(rows) {
  const sorted = [...rows].sort((a, b) => byBuilding.compare(a.id, b.id));
  const grouped = Object.keys(groups).map(kind => [kind, sorted.filter(row => row.kind === kind)])
    .filter(([, matches]) => matches.length);
  const summary = [], details = [];
  for (const [kind, matches] of grouped) {
    const title = groups[kind] + ' ' + matches.length + ' 栋';
    details.push(title);
    if (kind === 'population' || kind === 'level' || kind === 'maximum') {
      for (const threshold of [...new Set(matches.map(row => row.required))].sort((a,b) => a-b)) {
        const names = matches.filter(row => row.required === threshold).map(row => row.name);
        details.push(`  ${threshold}${kind === 'population' ? ' 人' : ' 级'}（${names.length} 栋） ${names.join('、')}`);
      }
    } else details.push(...matches.map(row => '  ' + upgradeReason(row)));
    if (kind === 'materials') {
      summary.push(...matches.slice(0, 2).map(upgradeReason));
      if (matches.length > 2) summary.push('另有 ' + (matches.length - 2) + ' 栋缺材料');
    } else if (kind === 'population' || kind === 'level') {
      const next = Math.min(...matches.map(row => row.required));
      const count = matches.filter(row => row.required === next).length;
      summary.push(kind === 'level' ? `角色达 ${next} 级可满足 ${count} 栋的等级条件`
        : `人口 ${matches[0].current}/${next}，${count} 栋等待此门槛`);
    } else if (!summary.length) summary.push(title);
  }
  return { rows: grouped.flatMap(([, matches]) => matches), message: summary.join('；') || '当前无升级受限记录',
    detail: details.join('\n'), count: rows.length };
}

export function upgradeChanges(check, previous) {
  if (!previous) return check.message;
  const before = new Map(previous.rows.map(row => [row.id, row]));
  const changes = [];
  for (const row of check.rows) {
    const prior = before.get(row.id);
    if (JSON.stringify(prior) !== JSON.stringify(row)) {
      if (prior?.kind === 'materials' && row.kind === 'materials' && row.items.length === 1 &&
        prior.items.length === 1 && prior.items[0].id === row.items[0].id) {
        changes.push(`${row.name}的${row.items[0].name}缺口 ${prior.items[0].missing} → ${row.items[0].missing}`);
      } else changes.push(upgradeReason(row));
    }
    before.delete(row.id);
  }
  for (const prior of before.values()) changes.push(prior.name + '已移出上次的“' + groups[prior.kind] + '”清单');
  if (!changes.length) return null;
  if (!previous.count) return check.message;
  return changes.slice(0, 2).join('；') + (changes.length > 2 ? `；另有 ${changes.length - 2} 栋条件变化` : '');
}
