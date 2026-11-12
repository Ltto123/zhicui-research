/** User-curated papers, separate from task evidence and machine reading notes. */
export type LibraryReadingStatus = 'unread' | 'reading' | 'read';
export type LibraryReadScope = 'metadata' | 'abstract' | 'full_text';
export interface LibraryOrigin {
  runId: string;
  conversationId: string;
  evidenceId: string;
  readScope: LibraryReadScope;
}
export interface LibraryItem {
  id: string;
  projectId: string;
  title: string;
  authors?: string;
  year?: string;
  journal?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  readScope: LibraryReadScope;
  origins: LibraryOrigin[];
  tags: string[];
  note: string;
  readingStatus: LibraryReadingStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface LibraryUpdate {
  revision: number;
  tags?: string[];
  note?: string;
  readingStatus?: LibraryReadingStatus;
}
