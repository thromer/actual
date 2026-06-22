import * as api from '@actual-app/api';

import { isRecord } from '#utils';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveAccountId(idOrName: string): Promise<string>;
export async function resolveAccountId(
  idOrName: string | undefined,
): Promise<string | undefined>;
export async function resolveAccountId(
  idOrName: string | undefined,
): Promise<string | undefined> {
  if (!idOrName) {
    return idOrName;
  }
  if (idOrName.match(UUID_REGEX)) {
    return idOrName;
  }
  const queryObj = api
    .q('accounts')
    .filter({ name: idOrName })
    .select(['id', 'name']);
  // .limit(2);
  const result = await api.aqlQuery(queryObj);
  if (!isRecord(result) || !('data' in result)) {
    throw new Error('Query result missing data');
  }
  const accounts = result.data as { id: string }[];
  console.log(
    `resolveAccountId(${idOrName}): accounts=${JSON.stringify(accounts, null, 2)}`,
  );
  if (accounts.length === 1) {
    return (accounts[0] as { id: string }).id;
  }
  if (accounts.length > 1) {
    process.stderr.write(`Warning: multiple accounts with name ${idOrName}\n`); // TODO better to just throw
  }
  return idOrName;
}
