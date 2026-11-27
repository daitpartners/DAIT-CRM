import { useContext, useEffect, type MutableRefObject } from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';
import type { ComposerGuard } from './DraftComposer';

type Props = { guard: MutableRefObject<ComposerGuard | null> };

/**
 * Leaving the Email screen while a composer (the New message page, an inline Reply) holds something unsaved — the
 * sidebar, the browser's Back, any other in-app navigation: the navigation waits for the composer's guarded close. A
 * good save lets it go on; a failed one keeps the editor where it is with the reason (and `Close without saving` on a
 * save that cannot work again, which then lets it go on). Nothing is held when nothing is unsaved. Only under the app's
 * data router (useBlocker needs one); elsewhere (screen tests in a plain MemoryRouter) it does nothing.
 */
export function LeaveGuard({ guard }: Props) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  return dataRouter ? <Blocker guard={guard} /> : null;
}

function Blocker({ guard }: Props) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (
    (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search) && !!guard.current?.pending()
  ));

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const release = guard.current;
    if (!release) {
      blocker.proceed();
      return;
    }
    let live = true;
    void release().then((ok) => {
      if (!live) return;
      if (ok) blocker.proceed();
      else blocker.reset();
    });
    return () => {
      live = false;
    };
    // Once per blocked navigation.
  }, [blocker.state]);

  return null;
}
