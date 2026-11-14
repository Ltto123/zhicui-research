'use client';

import {createContext, useContext, useEffect, useState, type ComponentProps} from 'react';
import {withSourceReturn} from '../lib/workspace-return';

export const SourceReturnContext = createContext<string | undefined>(undefined);

/** Preserve the originating workbench view when the reader opens in a new tab. */
export function SourceLink({href, ...props}: ComponentProps<'a'>) {
  const returnTo = useContext(SourceReturnContext);
  const [origin, setOrigin] = useState<string>();
  // The first browser render matches server HTML; same-origin absolute links
  // receive their context after mounting, when the current origin is available.
  useEffect(() => { setOrigin(window.location.origin); }, []);
  return <a {...props} href={href ? withSourceReturn(href, returnTo, origin) : href} />;
}
