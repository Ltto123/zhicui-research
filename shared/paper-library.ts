import type {LibraryReadScope} from './library';

export interface PaperOrigin {
  conversationId: string;
  conversationTitle: string;
  runId: string;
  evidenceId: string;
  kind: 'candidate' | 'evidence';
}

export interface PaperLibraryItem {
  id: string;
  title: string;
  authors?: string;
  year?: string;
  journal?: string;
  publicationType?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  readScope: LibraryReadScope;
  origins: PaperOrigin[];
  readerUrl?: string;
  cachedPdfUrl?: string;
  resourceUrls: string[];
  collectOrigin?: PaperOrigin;
  isCollected: boolean;
  canUpgradeCollection: boolean;
}

export interface PaperLibraryPage {
  items: PaperLibraryItem[];
  total: number;
  matched: number;
  offset: number;
  limit: number;
}
