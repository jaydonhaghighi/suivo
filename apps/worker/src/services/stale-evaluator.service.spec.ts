import { StaleEvaluatorService } from './stale-evaluator.service';

describe('StaleEvaluatorService', () => {
  it('marks lead stale and creates rescue task when stale window exceeded', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'team-1',
            team_lead_id: 'lead-1',
            stale_rules: { active_stale_hours: 1, at_risk_threshold_percent: 80, new_lead_sla_minutes: 60 },
            escalation_rules: { rescue_sequences: [] }
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'lead-1',
            team_id: 'team-1',
            owner_agent_id: 'agent-1',
            state: 'Active',
            created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            last_touch_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            fields_json: {}
          }
        ]
      })
      .mockResolvedValue({ rows: [] });

    const db = {
      withTransaction: async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query })
    };

    const service = new StaleEvaluatorService(db as never);
    const result = await service.evaluateAll();

    expect(result.processed).toBe(1);
    expect(result.stale).toBe(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET state = \'Stale\''),
      ['lead-1']
    );
  });
});
