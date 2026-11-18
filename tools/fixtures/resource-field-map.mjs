import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { mapPath } from '../../src/world.mjs';

// A unique synthetic scenario avoids touching an installed game map. The
// production loader still parses its normal JsonAsset format in these tests.
export function installResourceFieldMap(fixture) {
  const scenario = randomInt(100000000, 200000000), file = mapPath(scenario);
  const data = Array(fixture.map.width * fixture.map.height).fill(0);
  for (const field of fixture.state.mapFields) data[field.gridIdx] = field.resType * 10000 + field.cityId;
  const asset = [null, null, null, null, null, [[null, null, {
    mapData: data, mapInfo: { width: fixture.map.width, height: fixture.map.height }, cityInfo: fixture.map.cityInfo,
  }]]];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(asset), { flag: 'wx' });
  fixture.player.scenarioId = scenario;
  fixture.config.tables[scenario + '_CityCfg'] = fixture.config.tables['1_CityCfg'];
  fixture.config.tables[scenario + '_ResFieldTypeCfg'] = fixture.config.tables['1_ResFieldTypeCfg'];
  return () => fs.rmSync(file, { force: true });
}
