/**
 * Fingerprint hardening for stealth scrapes. Headless Chromium announces
 * itself in several places that bot checks read first; this makes those
 * places look like an ordinary desktop Chrome. It is not a guarantee: checks
 * that score IP reputation or behaviour still need a clean proxy
 * (STEALTH_PROXY_SERVER).
 */

/** A desktop Chrome user agent matching the running browser's version. */
export function chromeUserAgent(browserVersion: string): string {
  const major = browserVersion.split('.')[0] || '131';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Runs in every page before its own scripts. */
export const STEALTH_INIT_SCRIPT = `(() => {
  const define = (object, property, value) => {
    try {
      Object.defineProperty(object, property, { get: () => value, configurable: true });
    } catch {}
  };

  define(Navigator.prototype, 'webdriver', false);

  if (!window.chrome) {
    window.chrome = { runtime: {}, app: { isInstalled: false }, csi: () => ({}), loadTimes: () => ({}) };
  }

  if (!navigator.plugins || navigator.plugins.length === 0) {
    const plugin = { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' };
    define(Navigator.prototype, 'plugins', [plugin, { ...plugin, name: 'Chrome PDF Viewer' }]);
  }

  define(Navigator.prototype, 'hardwareConcurrency', 8);
  define(Navigator.prototype, 'deviceMemory', 8);

  const permissions = navigator.permissions;
  if (permissions && permissions.query) {
    const query = permissions.query.bind(permissions);
    permissions.query = (descriptor) =>
      descriptor && descriptor.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : query(descriptor);
  }

  const patchWebGL = (prototype) => {
    if (!prototype) return;
    const getParameter = prototype.getParameter;
    prototype.getParameter = function (parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    };
  };
  patchWebGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchWebGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();`;
