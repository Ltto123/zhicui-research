export interface WorkspaceReturnLocation {
  conversationId?: string;
  projectId?: string;
  tab?: 'materials' | 'library' | 'artifacts';
  artifactId?: string;
  saved?: boolean;
  savedLibraryId?: string;
  libraryItemId?: string;
  paperHash?: string;
}

const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuid = new RegExp(`^${uuidPattern}$`, 'i');
const paperHash = new RegExp(`^#papers/${uuidPattern}(?:/${uuidPattern})?$`, 'i');
const unsafeCharacters = /[\u0000-\u0020\u007f-\u009f\\]/;
const queryFields = new Set(['conversation', 'project', 'tab', 'artifact', 'saved', 'savedLibrary', 'libraryItem']);
const parseOrigin = 'https://workspace.invalid';

function locationHref(location: WorkspaceReturnLocation): string {
  const query = new URLSearchParams();
  if (location.conversationId !== undefined) query.set('conversation', location.conversationId);
  if (location.projectId !== undefined) query.set('project', location.projectId);
  if (location.tab !== undefined) query.set('tab', location.tab);
  if (location.artifactId !== undefined) query.set('artifact', location.artifactId);
  if (location.saved) query.set('saved', '1');
  if (location.savedLibraryId !== undefined) query.set('savedLibrary', location.savedLibraryId);
  if (location.libraryItemId !== undefined) query.set('libraryItem', location.libraryItemId);
  return '/' + (query.size ? `?${query}` : '') + (location.paperHash ?? '');
}

/** Only workbench UI state is accepted; a return link cannot navigate elsewhere. */
export function readWorkspaceReturn(raw: string): WorkspaceReturnLocation | undefined {
  if (!raw || raw.length > 2048 || !/^\/(?:\?|#|$)/.test(raw) || unsafeCharacters.test(raw)) return undefined;
  try {
    if (unsafeCharacters.test(decodeURIComponent(raw))) return undefined;
    const url = new URL(raw, parseOrigin);
    if (url.origin !== parseOrigin || url.pathname !== '/' || url.hash && !paperHash.test(url.hash)) return undefined;
    const seen = new Set<string>();
    for (const [key, value] of url.searchParams) {
      if (!queryFields.has(key) || seen.has(key)) return undefined;
      seen.add(key);
      if (key === 'tab') {
        if (!['materials', 'library', 'artifacts'].includes(value)) return undefined;
      } else if (key === 'saved') {
        if (value !== '1') return undefined;
      } else if (!uuid.test(value)) return undefined;
    }
    const result: WorkspaceReturnLocation = {};
    if (url.searchParams.has('conversation')) result.conversationId = url.searchParams.get('conversation')!;
    if (url.searchParams.has('project')) result.projectId = url.searchParams.get('project')!;
    if (url.searchParams.has('tab')) result.tab = url.searchParams.get('tab') as WorkspaceReturnLocation['tab'];
    if (url.searchParams.has('artifact')) result.artifactId = url.searchParams.get('artifact')!;
    if (url.searchParams.has('saved')) result.saved = true;
    if (url.searchParams.has('savedLibrary')) result.savedLibraryId = url.searchParams.get('savedLibrary')!;
    if (url.searchParams.has('libraryItem')) result.libraryItemId = url.searchParams.get('libraryItem')!;
    if (url.hash) result.paperHash = url.hash;
    return result;
  } catch { return undefined; }
}

export function safeWorkspaceReturn(raw: string | null | undefined): string | undefined {
  const location = typeof raw === 'string' ? readWorkspaceReturn(raw) : undefined;
  return location ? locationHref(location) : undefined;
}

export function workspaceReturnHref(location: WorkspaceReturnLocation): string {
  if (location.paperHash !== undefined && !paperHash.test(location.paperHash)) return '/';
  return safeWorkspaceReturn(locationHref(location)) ?? '/';
}

/** Attach the actual opening view without changing the source/citation identity. */
export function withSourceReturn(href: string, returnTo: string | undefined, origin?: string): string {
  const destination = safeWorkspaceReturn(returnTo);
  if (!destination || unsafeCharacters.test(href)) return href;
  const relative = href.startsWith('/source?');
  if (!relative && (!origin || !/^https?:\/\//i.test(href))) return href;
  try {
    const url = new URL(href, parseOrigin);
    if (url.pathname !== '/source' || url.username || url.password) return href;
    if (!relative) {
      const current = new URL(origin!);
      if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password || url.origin !== current.origin) return href;
    }
    url.searchParams.set('returnTo', destination);
    return relative ? url.pathname + url.search + url.hash : url.href;
  } catch { return href; }
}
