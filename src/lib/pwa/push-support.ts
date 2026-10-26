export type PushSupport = "ready" | "ios_install_required" | "ios_too_old" | "unsupported";

export interface BrowserTraits {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
}

const MIN_IOS = { major: 16, minor: 4 };

/** iPhone/iPad/iPod, ou iPadOS que se apresenta como Macintosh mas tem toque. */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function iosVersion(userAgent: string): { major: number; minor: number } | null {
  const match = /OS (\d+)[_.](\d+)/.exec(userAgent);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function pushSupport(traits: BrowserTraits): PushSupport {
  if (isIos(traits.userAgent, traits.maxTouchPoints)) {
    const version = iosVersion(traits.userAgent);
    // iPadOS com UA Macintosh não traz versão: segue para a checagem de instalação.
    if (version && (version.major < MIN_IOS.major || (version.major === MIN_IOS.major && version.minor < MIN_IOS.minor))) {
      return "ios_too_old";
    }
    if (!traits.standalone) return "ios_install_required";
  }
  if (!traits.hasServiceWorker || !traits.hasPushManager || !traits.hasNotification) return "unsupported";
  return "ready";
}

/** Só no cliente. */
export function readBrowserTraits(): BrowserTraits {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
    standalone: window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true,
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
  };
}
