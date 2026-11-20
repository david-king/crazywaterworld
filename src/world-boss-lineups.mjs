import { prepareFleetLineups } from './fleet-lineups.mjs';

export { recoverFleetLineups as recoverWorldBossLineups, markFleetLineupsDispatched as markWorldBossLineupsDispatched,
  markFleetLineupsCancelled as markWorldBossLineupsCancelled } from './fleet-lineups.mjs';

export async function prepareWorldBossLineups(client, config, player, { settings, fleetIds, ...options }) {
  if (!Array.isArray(fleetIds) || fleetIds.some(id => typeof id !== 'string' || !/^[1-9]\d*远征船$/.test(id))
    || new Set(fleetIds).size !== fleetIds.length) throw new Error('世界Boss出战舰队选择无效');
  const selections = (settings?.worldBoss?.fleetPresets ?? []).filter(binding => fleetIds.includes(binding.buildingId))
    .map(binding => ({ buildingId: binding.buildingId, preset: settings.lineups?.presets?.find(row => row.id === binding.presetId) }));
  return prepareFleetLineups(client, config, player, { ...options, kind: 'worldBossLineup', fleetIds, selections });
}
