import { send } from 'loot-core/platform/client/fetch';
import { type Query } from 'loot-core/shared/query';

export async function aqlQuery(query: Query) {
 const s = query.serialize();
  console.debug(`${Number(performance.now()/1000).toFixed(9)} aqlQuery: ${JSON.stringify(s)}`);
  return send('query', s);
}
