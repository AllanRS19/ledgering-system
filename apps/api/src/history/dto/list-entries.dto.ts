import { PageQueryDto } from './page-query.dto';

/**
 * Query string of GET /wallets/:walletId/entries. For now it only takes the
 * shared page parameters (the wallet is in the path). It is its own class so
 * this endpoint's contract has a home, and a filter (say, `direction`) can
 * be added later without touching the other endpoint.
 */
export class ListEntriesQueryDto extends PageQueryDto {}
