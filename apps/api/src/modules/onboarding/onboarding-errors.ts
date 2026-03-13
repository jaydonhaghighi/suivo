const USER_CLERK_ID_CONSTRAINTS = new Set(['ux_user_clerk_id', 'User_clerk_id_key']);

export function isUserClerkIdUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const pgError = error as {
    code?: string;
    constraint?: string;
    table?: string;
    detail?: string;
  };

  if (pgError.code !== '23505') {
    return false;
  }

  if (pgError.constraint && USER_CLERK_ID_CONSTRAINTS.has(pgError.constraint)) {
    return true;
  }

  return (
    (pgError.table === 'User' || pgError.table === '"User"')
    && typeof pgError.detail === 'string'
    && pgError.detail.includes('(clerk_id)')
  );
}

export function isTeamJoinCodeUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const pgError = error as { code?: string; constraint?: string; table?: string; detail?: string };
  if (pgError.code !== '23505') {
    return false;
  }

  if (pgError.constraint === 'ux_team_join_code_hash') {
    return true;
  }

  return (
    (pgError.table === 'Team' || pgError.table === '"Team"')
    && typeof pgError.detail === 'string'
    && pgError.detail.includes('(join_code_hash)')
  );
}
