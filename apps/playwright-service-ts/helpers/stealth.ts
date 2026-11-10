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
    // Real PluginArray/Plugin prototypes, so instanceof and toString checks
    // see what a desktop Chrome returns. The native getters reject objects
    // they did not create, so every property read is defined on the instance.
    const makePlugin = (name) => {
      const plugin = Object.create(Plugin.prototype);
      for (const [key, value] of Object.entries({
        name,
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        length: 0,
      })) {
        Object.defineProperty(plugin, key, { value, enumerable: true });
      }
      return plugin;
    };
    const list = ['PDF Viewer', 'Chrome PDF Viewer'].map(makePlugin);
    const plugins = Object.create(PluginArray.prototype);
    list.forEach((plugin, index) => {
      Object.defineProperty(plugins, index, { value: plugin, enumerable: true });
      Object.defineProperty(plugins, plugin.name, { value: plugin });
    });
    Object.defineProperty(plugins, 'length', { value: list.length });
    Object.defineProperty(plugins, 'item', { value: (index) => list[index] ?? null });
    Object.defineProperty(plugins, 'namedItem', {
      value: (name) => list.find((plugin) => plugin.name === name) ?? null,
    });
    Object.defineProperty(plugins, 'refresh', { value: () => {} });
    Object.defineProperty(plugins, Symbol.iterator, {
      value: () => list[Symbol.iterator](),
    });
    define(Navigator.prototype, 'plugins', plugins);
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
