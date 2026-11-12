import {useEffect, useState} from 'react';

interface PaperLocation {projectId: string; conversationId?: string}

function locationFromHash(): PaperLocation | null {
  const match = /^#papers\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?$/i.exec(window.location.hash);
  return match ? {projectId: match[1], conversationId: match[2]} : null;
}

/** Keep the conversation draft in memory while the user browses its sources. */
export function usePaperNavigation() {
  const [location, setLocation] = useState<PaperLocation | null>(null);
  useEffect(() => {
    const sync = () => setLocation(locationFromHash());
    sync();
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  function open(projectId: string, conversationId?: string) {
    const hash = '#papers/' + encodeURIComponent(projectId) + (conversationId ? '/' + encodeURIComponent(conversationId) : '');
    window.history.pushState({paperLibraryEntry: hash}, '', hash);
    setLocation({projectId, conversationId});
  }

  function close() {
    if (window.history.state?.paperLibraryEntry === window.location.hash) {
      window.history.back();
    } else {
      // A link opened directly has no previous workbench view to go back to.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setLocation(null);
    }
  }
  return {location, open, close};
}
