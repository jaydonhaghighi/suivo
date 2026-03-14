import { NotificationsService } from './notifications.service';

describe('NotificationsService feed scoping', () => {
  it('scopes team lead feed to owned leads plus stale leads', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [],
      rowCount: 0
    });

    const databaseService = {
      withSystemTransaction: jest.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) =>
        fn({ query })
      )
    };

    const service = new NotificationsService(databaseService as never);

    await service.getFeed(
      { userId: 'team-lead-1', teamId: 'team-1', role: 'TEAM_LEAD' },
      25
    );

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain('l.owner_agent_id = $3');
    expect(sql).toContain("OR ($2 = 'TEAM_LEAD' AND l.state = 'Stale')");
    expect(params).toEqual(['team-1', 'TEAM_LEAD', 'team-lead-1', 25]);
  });
});
