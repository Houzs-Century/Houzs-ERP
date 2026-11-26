import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { ownServiceAndProjectRowKeys } from './delivery-pod-context';

function envWithProject(project: Record<string, unknown>): Env {
  const db = {
    prepare: (_sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => project,
      }),
    }),
  };
  return { DB: db } as unknown as Env;
}

const NO_IDS = {
  setup_driver_user_id: null, setup_helper_1_id: null, setup_helper_2_id: null,
  dismantle_driver_user_id: null, dismantle_helper_1_id: null, dismantle_helper_2_id: null,
};

describe('ownServiceAndProjectRowKeys — Setup/Dismantle crew scope', () => {
  const scope = { driverIds: new Set<string>(), helperIds: new Set<string>() };
  const projectRows = [{ row_type: 'project', so_doc_no: 'PRJ:123#SETUP' }];
  const sb = {} as unknown as Parameters<typeof ownServiceAndProjectRowKeys>[0];

  it('includes the Setup row when the driver is in setup_crew JSON by NAME (no user id)', async () => {
    const env = envWithProject({ ...NO_IDS, setup_crew: '[{"name":"Aimir","phone":"012"}]', dismantle_crew: null });
    const own = await ownServiceAndProjectRowKeys(sb, env, scope, 5, 'Aimir', projectRows);
    expect(own.has('PRJ:123#SETUP')).toBe(true);
  });

  it('excludes the Setup row when the driver is neither a crew id nor a crew name', async () => {
    const env = envWithProject({ ...NO_IDS, setup_crew: '[{"name":"Aimir","phone":"012"}]', dismantle_crew: null });
    const own = await ownServiceAndProjectRowKeys(sb, env, scope, 5, 'Bob', projectRows);
    expect(own.has('PRJ:123#SETUP')).toBe(false);
  });

  it('still includes the Setup row for a legacy scalar crew user id', async () => {
    const env = envWithProject({ ...NO_IDS, setup_driver_user_id: 5, setup_crew: null, dismantle_crew: null });
    const own = await ownServiceAndProjectRowKeys(sb, env, scope, 5, null, projectRows);
    expect(own.has('PRJ:123#SETUP')).toBe(true);
  });

  it('does not match a DISMANTLE assignment to a SETUP row', async () => {
    const env = envWithProject({ ...NO_IDS, setup_crew: null, dismantle_crew: '[{"name":"Aimir"}]' });
    const own = await ownServiceAndProjectRowKeys(sb, env, scope, 5, 'Aimir', projectRows);
    expect(own.has('PRJ:123#SETUP')).toBe(false);
  });
});
