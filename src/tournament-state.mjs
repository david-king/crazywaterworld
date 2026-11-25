// 1 预选，2–6 正赛，7 公示，8 结束。赛场及每日礼包入口在预选之后、结束之前开放。
export const tournamentRunning = state => state?.stageId > 1 && state.stageId < 8;

export function rememberTournament(client, name, body) {
  if (name === 'SCTournamentOpen') {
    client.tournament = {
      stageId: body?.state?.currentStageId ?? 0,
      nextMatchTime: body?.state?.nextMatchTime ?? 0,
      nextMatchTimeId: body?.state?.nextMatchTimeId ?? 0,
      qualified: body?.contestant?.qualified === true,
      lastClaimDailyGiftTime: body?.lastClaimDailyGiftTime ?? 0,
    };
  } else if (name === 'SCTournamentUpdate' && client.tournament && body?.state) {
    client.tournament.stageId = body.state.currentStageId ?? client.tournament.stageId;
    client.tournament.nextMatchTime = body.state.nextMatchTime ?? client.tournament.nextMatchTime;
    client.tournament.nextMatchTimeId = body.state.nextMatchTimeId ?? client.tournament.nextMatchTimeId;
  } else if (name === 'SCTournamentContestantUpdate' && client.tournament) {
    client.tournament.qualified = body?.contestant?.qualified === true;
  }
}
