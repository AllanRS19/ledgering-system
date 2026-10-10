import { SUPPORTED_CURRENCIES } from '../../common/constants';

export interface WalletSummary {
  id: string;
  currency: string;
  balance: bigint;
  createdAt: Date;
}

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
